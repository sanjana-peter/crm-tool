import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "@/lib/domain/errors";
import {
  describeInstagramMessage,
  INSTAGRAM_MAX_TEXT_LENGTH,
  instagramContactName,
  isOptOutText,
  isWithinServiceWindow,
  nextInstagramStatus,
  type ConsentStatus,
  type InstagramMessageStatus,
  type InstagramMessageType,
} from "@/lib/domain/instagram";
import { logger, type Logger } from "@/lib/observability/logger";
import type {
  InstagramConnection,
  InstagramDeletedEvent,
  InstagramEchoEvent,
  InstagramEvent,
  InstagramMessageEvent,
  InstagramProvider,
  InstagramReadEvent,
  SendFailureCode,
} from "@/lib/ports/instagram";
import { logActivity } from "@/lib/services/activities";
import { assignmentStrategyFor } from "@/lib/services/assignment";
import { captureLead } from "@/lib/services/capture";
import { getOrCreateConversation, leadForContact, type EventOutcome } from "@/lib/services/conversations";
import { getInstagramToken } from "@/lib/services/instagram";
import { markConnected, markFailing } from "@/lib/services/integration-health";
import { beginReceipt, finishReceipt } from "@/lib/services/webhooks";

/** The provider + credentials the caller resolved for one org (see `composition/instagram.ts`). */
export interface InstagramRuntime {
  provider: InstagramProvider;
  connection: InstagramConnection;
  /** `demo` when a mock is standing in — nothing is really delivered. */
  mode: "live" | "demo";
}

export interface InstagramMessageRow {
  id: string;
  lead_id: string;
  direction: "outbound" | "inbound";
  message_type: InstagramMessageType;
  body: string;
  attachment_url: string | null;
  status: InstagramMessageStatus;
  is_echo: boolean;
  error: string | null;
  error_code: string | null;
  sent_by: string | null;
  read_at: string | null;
  created_at: string;
  sender?: { id: string; email: string; full_name: string | null } | null;
}

export interface InstagramConversationState {
  id: string | null;
  /** The contact's IGSID, or null if they've never messaged the org on Instagram. */
  instagramUserId: string | null;
  username: string | null;
  lastInboundAt: string | null;
  /** Whether a reply is allowed right now. */
  windowOpen: boolean;
  consent: ConsentStatus;
}

export type InstagramSendResult =
  | { status: "sent"; messageId: string }
  | { status: "failed"; error: string; code: SendFailureCode };

const UNIQUE_VIOLATION = "23505";
const PROVIDER = "instagram";
/** `lead_inquiries.external_provider` for a lead captured from a DM. */
export const INSTAGRAM_DM_SOURCE = "instagram_dm";

// ---------------------------------------------------------------------------
// Reads (RLS-scoped)
// ---------------------------------------------------------------------------

export async function getInstagramConversationState(db: SupabaseClient, leadId: string): Promise<InstagramConversationState> {
  const empty: InstagramConversationState = {
    id: null,
    instagramUserId: null,
    username: null,
    lastInboundAt: null,
    windowOpen: false,
    consent: "unknown",
  };
  const { data: lead } = await db.from("leads").select("contact_id").eq("id", leadId).maybeSingle();
  if (!lead) return empty;

  const [{ data: conversation }, { data: contact }] = await Promise.all([
    db.from("conversations").select("id, last_inbound_at").eq("contact_id", lead.contact_id).eq("channel", "instagram").maybeSingle(),
    db.from("contacts").select("instagram_user_id, instagram_username, instagram_consent_status").eq("id", lead.contact_id).maybeSingle(),
  ]);

  const lastInboundAt = (conversation?.last_inbound_at as string | null | undefined) ?? null;
  return {
    id: (conversation?.id as string | undefined) ?? null,
    instagramUserId: (contact?.instagram_user_id as string | null | undefined) ?? null,
    username: (contact?.instagram_username as string | null | undefined) ?? null,
    lastInboundAt,
    windowOpen: isWithinServiceWindow(lastInboundAt),
    consent: (contact?.instagram_consent_status as ConsentStatus | undefined) ?? "unknown",
  };
}

export async function listInstagramMessagesForLead(db: SupabaseClient, leadId: string): Promise<InstagramMessageRow[]> {
  const { data: lead } = await db.from("leads").select("contact_id").eq("id", leadId).maybeSingle();
  if (!lead) return [];

  // The conversation belongs to the contact, so earlier DMs show on a new lead too.
  const { data: conversation } = await db
    .from("conversations")
    .select("id")
    .eq("contact_id", lead.contact_id)
    .eq("channel", "instagram")
    .maybeSingle();
  if (!conversation) return [];

  const { data, error } = await db
    .from("instagram_messages")
    .select("*, sender:sent_by(id, email, full_name)")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Failed to load Instagram messages: ${error.message}`);
  return (data ?? []) as unknown as InstagramMessageRow[];
}

export async function setInstagramConsent(db: SupabaseClient, params: { contactId: string; status: ConsentStatus }): Promise<void> {
  const { error } = await db
    .from("contacts")
    .update({
      instagram_consent_status: params.status,
      instagram_consent_at: params.status === "unknown" ? null : new Date().toISOString(),
    })
    .eq("id", params.contactId);
  if (error) throw new Error(`Failed to update consent: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Replies to a lead on Instagram. Only inside the 24-hour window the customer
 * opened by messaging the account — Instagram has no templates for anything
 * else. The caller checks the acting user may access this lead; this runs as
 * the service role because the org's token is unreadable to any other role.
 */
export async function sendInstagramText(
  admin: SupabaseClient,
  runtime: InstagramRuntime,
  params: { orgId: string; leadId: string; body: string; sentByUserId: string }
): Promise<InstagramSendResult> {
  const body = params.body.trim();
  if (!body) throw new UserError("Write a message first.");
  if (body.length > INSTAGRAM_MAX_TEXT_LENGTH) {
    throw new UserError(`Instagram messages are limited to ${INSTAGRAM_MAX_TEXT_LENGTH} characters.`);
  }

  const { data: lead, error } = await admin
    .from("leads")
    .select("id, contact_id, first_contacted_at, contact:contacts!leads_org_contact_fkey(instagram_user_id, instagram_consent_status)")
    .eq("id", params.leadId)
    .eq("org_id", params.orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load lead: ${error.message}`);
  if (!lead) throw new UserError("Lead not found.");

  const contact = (Array.isArray(lead.contact) ? lead.contact[0] : lead.contact) as
    | { instagram_user_id: string | null; instagram_consent_status: ConsentStatus }
    | null;
  if (!contact?.instagram_user_id) {
    throw new UserError("This lead hasn't messaged you on Instagram, so there's no conversation to reply to.");
  }
  if (contact.instagram_consent_status === "opted_out") {
    throw new UserError("This contact asked not to be messaged on Instagram, so nothing can be sent.");
  }

  const contactId = lead.contact_id as string;
  const conversationId = await getOrCreateConversation(admin, params.orgId, contactId, "instagram");
  const { data: conversation } = await admin.from("conversations").select("last_inbound_at").eq("id", conversationId).single();
  if (!isWithinServiceWindow((conversation?.last_inbound_at as string | null) ?? null)) {
    throw new UserError(
      "The 24-hour reply window is closed — Instagram only allows a reply after the customer messages you again."
    );
  }

  const outcome = await runtime.provider.sendText(runtime.connection, { recipientId: contact.instagram_user_id, body });

  const row = {
    org_id: params.orgId,
    lead_id: params.leadId,
    conversation_id: conversationId,
    direction: "outbound",
    message_type: "text",
    body,
    provider_message_id: outcome.ok ? outcome.providerMessageId : null,
    status: outcome.ok ? "sent" : "failed",
    is_echo: false,
    error: outcome.ok ? null : outcome.error.slice(0, 500),
    error_code: outcome.ok ? null : outcome.code,
    sent_by: params.sentByUserId,
  };
  const { error: insertError } = await admin.from("instagram_messages").insert(row);
  if (insertError?.code === UNIQUE_VIOLATION && outcome.ok) {
    // Instagram's echo of this very message beat us here; claim it as ours.
    await admin
      .from("instagram_messages")
      .update({ sent_by: params.sentByUserId, is_echo: false, lead_id: params.leadId })
      .eq("org_id", params.orgId)
      .eq("provider_message_id", outcome.providerMessageId);
  } else if (insertError) {
    throw new Error(`Failed to log the Instagram message: ${insertError.message}`);
  }

  await admin.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  const demo = runtime.mode === "demo" ? " (demo mode — not delivered)" : "";
  if (outcome.ok) {
    await logActivity(admin, {
      orgId: params.orgId,
      leadId: params.leadId,
      actorId: params.sentByUserId,
      type: "instagram_sent",
      title: `Instagram reply sent${demo}`,
      description: body,
    });
    if (!lead.first_contacted_at) {
      await admin
        .from("leads")
        .update({ first_contacted_at: new Date().toISOString() })
        .eq("id", params.leadId)
        .eq("org_id", params.orgId)
        .is("first_contacted_at", null);
    }
    if (runtime.mode === "live") await markConnected(admin, params.orgId, "instagram");
    return { status: "sent", messageId: outcome.providerMessageId };
  }

  // A failure is a timeline event: the salesperson must know it didn't arrive.
  await logActivity(admin, {
    orgId: params.orgId,
    leadId: params.leadId,
    actorId: params.sentByUserId,
    type: "instagram_failed",
    title: "Instagram message failed",
    description: outcome.error,
    metadata: { code: outcome.code },
  });
  // Only failures about the integration itself turn the admin's page red.
  if (runtime.mode === "live" && (outcome.code === "auth" || outcome.code === "other")) {
    await markFailing(admin, params.orgId, "instagram", outcome.error);
  }
  return { status: "failed", error: outcome.error, code: outcome.code };
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

async function resolveOrg(admin: SupabaseClient, provider: InstagramProvider, accountId: string): Promise<string | null> {
  // The demo provider addresses a tenant directly: `mock:<orgId>`.
  if (provider.isMock && accountId.startsWith("mock:")) {
    const orgId = accountId.slice("mock:".length);
    const { data } = await admin.from("organizations").select("id").eq("id", orgId).maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }
  if (provider.isMock) return null;

  const { data } = await admin.from("instagram_connections").select("org_id").eq("ig_user_id", accountId).maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

async function connectionFor(
  admin: SupabaseClient,
  provider: InstagramProvider,
  orgId: string,
  accountId: string
): Promise<InstagramConnection | null> {
  if (provider.isMock) return { accountId, accessToken: "mock" };
  const token = await getInstagramToken(admin, orgId).catch(() => null);
  return token ? { accountId, accessToken: token } : null;
}

async function findContactByInstagramId(admin: SupabaseClient, orgId: string, instagramUserId: string) {
  const { data } = await admin
    .from("contacts")
    .select("id, first_name")
    .eq("org_id", orgId)
    .eq("instagram_user_id", instagramUserId)
    .maybeSingle();
  return data as { id: string; first_name: string } | null;
}

/**
 * A DM. Someone the CRM already knows gets it on their lead; a stranger
 * becomes a new contact + lead through `captureLead` (source "Instagram"),
 * assigned by the org's assignment strategy — an Instagram sender has no
 * phone or email to match on, so "unmatched" would mean "lost".
 */
async function handleMessage(
  admin: SupabaseClient,
  orgId: string,
  provider: InstagramProvider,
  event: InstagramMessageEvent,
  log: Logger
): Promise<EventOutcome> {
  const body = describeInstagramMessage(event.messageType, event.text);
  let contact = await findContactByInstagramId(admin, orgId, event.senderId);
  let leadId = contact ? await leadForContact(admin, orgId, contact.id) : null;
  let senderName = contact?.first_name ?? null;

  if (!contact || !leadId) {
    const connection = await connectionFor(admin, provider, orgId, event.accountId);
    const profile = connection ? await provider.getProfile(connection, event.senderId) : null;
    const name = instagramContactName(profile);
    const handle = profile?.username ? `@${profile.username}` : null;

    const result = await captureLead(
      admin,
      { orgId, userId: null, role: null },
      {
        firstName: name.firstName,
        lastName: name.lastName,
        instagram: { userId: event.senderId, username: profile?.username ?? null },
        source: "Instagram",
        sourceDetail: handle ? `Instagram DM from ${handle}` : "Instagram DM",
        // Keyed on the sender, not the message: a burst of first DMs arriving as
        // concurrent deliveries then race into the leads unique index and
        // resolve to one lead, instead of each creating its own.
        external: { provider: INSTAGRAM_DM_SOURCE, id: event.senderId },
        receivedAt: event.occurredAt,
        timeline: {
          type: "lead_created",
          title: handle ? `New lead from an Instagram DM (${handle})` : "New lead from an Instagram DM",
        },
      },
      { assignment: await assignmentStrategyFor(admin, orgId) }
    );
    // Losing a race with a concurrent first DM can come back as "duplicate"
    // before the winner's lead is readable: find it, or fail so Meta retries
    // this message rather than it being dropped.
    const contactId =
      (result.outcome !== "existing_restricted" ? result.contactId : null) ??
      (await findContactByInstagramId(admin, orgId, event.senderId))?.id ??
      null;
    const capturedLeadId =
      (result.outcome !== "existing_restricted" ? result.leadId : null) ??
      (contactId ? await leadForContact(admin, orgId, contactId) : null);
    if (!contactId || !capturedLeadId) {
      throw new Error("The lead for this Instagram sender is still being created; the delivery will be retried.");
    }

    contact = { id: contactId, first_name: name.firstName };
    leadId = capturedLeadId;
    senderName = name.firstName;
    log.info("instagram.lead_captured", { orgId, outcome: result.outcome });
  }

  const conversationId = await getOrCreateConversation(admin, orgId, contact.id, "instagram");
  const { error } = await admin.from("instagram_messages").insert({
    org_id: orgId,
    lead_id: leadId,
    conversation_id: conversationId,
    direction: "inbound",
    message_type: event.messageType,
    body,
    attachment_url: event.attachmentUrl,
    provider_message_id: event.providerMessageId,
    status: "received",
    created_at: event.occurredAt,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return "duplicate";
    throw new Error(`Failed to store the Instagram message: ${error.message}`);
  }

  await admin
    .from("conversations")
    .update({ last_inbound_at: event.occurredAt, last_message_at: event.occurredAt })
    .eq("id", conversationId);

  await logActivity(admin, {
    orgId,
    leadId,
    actorId: null,
    type: "instagram_received",
    title: `Instagram DM from ${senderName ?? "the contact"}`,
    description: body,
  });

  if (isOptOutText(event.text)) {
    await admin
      .from("contacts")
      .update({ instagram_consent_status: "opted_out", instagram_consent_at: new Date().toISOString() })
      .eq("id", contact.id);
    await logActivity(admin, {
      orgId,
      leadId,
      actorId: null,
      type: "lead_updated",
      title: "Contact opted out of Instagram messages",
      description: "They replied STOP. No further Instagram messages will be sent.",
    });
  }

  return "processed";
}

/**
 * The business wrote to a customer. A CRM-sent message's echo finds the row
 * the send already wrote (same message id) and changes nothing; a reply typed
 * in the Instagram app itself is recorded so the CRM shows the whole thread.
 */
async function handleEcho(admin: SupabaseClient, orgId: string, event: InstagramEchoEvent): Promise<EventOutcome> {
  const { data: existing } = await admin
    .from("instagram_messages")
    .select("id")
    .eq("org_id", orgId)
    .eq("provider_message_id", event.providerMessageId)
    .maybeSingle();
  if (existing) return "duplicate";

  const contact = await findContactByInstagramId(admin, orgId, event.recipientId);
  if (!contact) return "unmatched"; // the business messaged someone who isn't in the CRM
  const leadId = await leadForContact(admin, orgId, contact.id);
  if (!leadId) return "unmatched";

  const conversationId = await getOrCreateConversation(admin, orgId, contact.id, "instagram");
  const body = describeInstagramMessage(event.messageType, event.text);
  const { error } = await admin.from("instagram_messages").insert({
    org_id: orgId,
    lead_id: leadId,
    conversation_id: conversationId,
    direction: "outbound",
    message_type: event.messageType,
    body,
    attachment_url: event.attachmentUrl,
    provider_message_id: event.providerMessageId,
    status: "sent",
    is_echo: true,
    created_at: event.occurredAt,
  });
  if (error) {
    // The CRM's own send recorded it a moment ago.
    if (error.code === UNIQUE_VIOLATION) return "duplicate";
    throw new Error(`Failed to store the Instagram message: ${error.message}`);
  }

  await admin.from("conversations").update({ last_message_at: event.occurredAt }).eq("id", conversationId);
  await logActivity(admin, {
    orgId,
    leadId,
    actorId: null,
    type: "instagram_sent",
    title: "Instagram reply sent from the Instagram app",
    description: body,
  });
  return "processed";
}

/** The customer unsent a message: honour it — the text is gone from the CRM too. */
async function handleDeleted(admin: SupabaseClient, orgId: string, event: InstagramDeletedEvent): Promise<EventOutcome> {
  const { data: message } = await admin
    .from("instagram_messages")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("provider_message_id", event.providerMessageId)
    .maybeSingle();
  if (!message) return "unmatched";

  const current = message.status as InstagramMessageStatus;
  if (nextInstagramStatus(current, "deleted") === current) return "ignored";

  await admin
    .from("instagram_messages")
    .update({ status: "deleted", body: "[Message unsent]", attachment_url: null })
    .eq("id", message.id);
  return "processed";
}

/** The customer has seen everything up to this message: every earlier outbound message is read. */
async function handleRead(admin: SupabaseClient, orgId: string, event: InstagramReadEvent): Promise<EventOutcome> {
  const contact = await findContactByInstagramId(admin, orgId, event.senderId);
  if (!contact) return "unmatched";

  const { data: conversation } = await admin
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("contact_id", contact.id)
    .eq("channel", "instagram")
    .maybeSingle();
  if (!conversation) return "unmatched";

  const { data: seen } = await admin
    .from("instagram_messages")
    .select("created_at")
    .eq("org_id", orgId)
    .eq("provider_message_id", event.providerMessageId)
    .maybeSingle();
  const upTo = (seen?.created_at as string | undefined) ?? event.occurredAt;

  const { data: updated } = await admin
    .from("instagram_messages")
    .update({ status: "read", read_at: event.occurredAt })
    .eq("conversation_id", conversation.id)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .lte("created_at", upTo)
    .select("id");
  return (updated ?? []).length > 0 ? "processed" : "ignored";
}

function eventKey(event: InstagramEvent): string {
  return event.kind === "read" ? `read:${event.senderId}:${event.providerMessageId}` : `${event.kind}:${event.providerMessageId}`;
}

/**
 * Applies a verified delivery, each event guarded by an idempotency receipt
 * so provider retries change nothing.
 */
export async function handleInstagramEvents(
  admin: SupabaseClient,
  params: { provider: InstagramProvider; events: InstagramEvent[]; requestId: string; log?: Logger }
): Promise<Array<{ providerMessageId: string; kind: InstagramEvent["kind"]; outcome: EventOutcome }>> {
  const log = params.log ?? logger.child({ provider: PROVIDER, requestId: params.requestId });
  const results: Array<{ providerMessageId: string; kind: InstagramEvent["kind"]; outcome: EventOutcome }> = [];

  for (const event of params.events) {
    const orgId = await resolveOrg(admin, params.provider, event.accountId);
    if (!orgId) {
      log.warn("instagram.unknown_account", { accountId: event.accountId });
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome: "unmatched" });
      continue;
    }

    const receipt = await beginReceipt(admin, { provider: PROVIDER, eventKey: eventKey(event), orgId, requestId: params.requestId });
    if (receipt.alreadyHandled) {
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome: "duplicate" });
      continue;
    }

    try {
      let outcome: EventOutcome;
      switch (event.kind) {
        case "message":
          outcome = await handleMessage(admin, orgId, params.provider, event, log);
          break;
        case "echo":
          outcome = await handleEcho(admin, orgId, event);
          break;
        case "deleted":
          outcome = await handleDeleted(admin, orgId, event);
          break;
        case "read":
          outcome = await handleRead(admin, orgId, event);
          break;
      }
      await finishReceipt(admin, receipt.id, { status: outcome });
      if (!params.provider.isMock && outcome === "processed") await markConnected(admin, orgId, "instagram");
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome });
    } catch (error) {
      await finishReceipt(admin, receipt.id, { status: "failed", error });
      log.error("instagram.event_failed", { orgId, eventKey: eventKey(event), error });
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome: "failed" });
    }
  }

  return results;
}
