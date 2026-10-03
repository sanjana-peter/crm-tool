import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "@/lib/domain/errors";
import { toWhatsAppRecipient } from "@/lib/domain/phone";
import {
  checkSendAllowed,
  isOptOutText,
  isWithinServiceWindow,
  nextMessageStatus,
  renderBody,
  templateApprovalError,
  type ConsentStatus,
  type MessageStatus,
} from "@/lib/domain/whatsapp";
import { logger, type Logger } from "@/lib/observability/logger";
import type {
  InboundMessageEvent,
  SendFailureCode,
  StatusEvent,
  WhatsAppConnection,
  WhatsAppEvent,
  WhatsAppProvider,
} from "@/lib/ports/whatsapp";
import { logActivity } from "@/lib/services/activities";
import { markConnected, markFailing } from "@/lib/services/integration-health";
import { beginReceipt, finishReceipt } from "@/lib/services/webhooks";

/** The provider + credentials the caller resolved for one org (see `composition/whatsapp.ts`). */
export interface WhatsAppRuntime {
  provider: WhatsAppProvider;
  connection: WhatsAppConnection;
  /** `demo` when a mock is standing in — nothing is really delivered. */
  mode: "live" | "demo";
}

export interface WhatsAppMessageRow {
  id: string;
  lead_id: string;
  direction: "outbound" | "inbound";
  message_type: "template" | "text";
  template_name: string | null;
  rendered_body: string;
  to_phone: string | null;
  from_phone: string | null;
  status: MessageStatus;
  error: string | null;
  error_code: string | null;
  sent_by: string | null;
  created_at: string;
  sender?: { id: string; email: string; full_name: string | null } | null;
}

export interface ConversationState {
  id: string | null;
  lastInboundAt: string | null;
  /** Whether a free-text reply is allowed right now. */
  windowOpen: boolean;
  consent: ConsentStatus;
}

export type SendResult =
  | { status: "sent"; messageId: string }
  | { status: "failed"; error: string; code: SendFailureCode };

const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type ConversationChannel = "whatsapp" | "instagram";

/** The contact's conversation on a channel, created on first use. Race-safe on the (org, contact, channel) key. */
export async function getOrCreateConversation(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
  channel: ConversationChannel = "whatsapp"
): Promise<string> {
  const find = () =>
    admin
      .from("conversations")
      .select("id")
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .eq("channel", channel)
      .maybeSingle();

  const { data: existing } = await find();
  if (existing) return existing.id as string;

  const { data, error } = await admin
    .from("conversations")
    .insert({ org_id: orgId, contact_id: contactId, channel })
    .select("id")
    .single();

  if (error?.code === UNIQUE_VIOLATION) {
    // A concurrent message created it first.
    const { data: raced } = await find();
    return raced!.id as string;
  }
  if (error) throw new Error(`Failed to open the conversation: ${error.message}`);
  return data.id as string;
}

/** Window and consent state for a lead's contact, for the composer UI. Reads with the caller's RLS view. */
export async function getConversationState(db: SupabaseClient, leadId: string): Promise<ConversationState> {
  const { data: lead } = await db.from("leads").select("contact_id").eq("id", leadId).maybeSingle();
  if (!lead) return { id: null, lastInboundAt: null, windowOpen: false, consent: "unknown" };

  const [{ data: conversation }, { data: contact }] = await Promise.all([
    db.from("conversations").select("id, last_inbound_at").eq("contact_id", lead.contact_id).eq("channel", "whatsapp").maybeSingle(),
    db.from("contacts").select("whatsapp_consent_status").eq("id", lead.contact_id).maybeSingle(),
  ]);

  const lastInboundAt = (conversation?.last_inbound_at as string | null | undefined) ?? null;
  return {
    id: (conversation?.id as string | undefined) ?? null,
    lastInboundAt,
    windowOpen: isWithinServiceWindow(lastInboundAt),
    consent: ((contact?.whatsapp_consent_status as ConsentStatus | undefined) ?? "unknown"),
  };
}

export async function listMessagesForLead(db: SupabaseClient, leadId: string): Promise<WhatsAppMessageRow[]> {
  const { data: lead } = await db.from("leads").select("contact_id").eq("id", leadId).maybeSingle();
  if (!lead) return [];

  // A conversation belongs to the contact, so a returning contact's earlier
  // messages show on their new lead too.
  const { data: conversation } = await db
    .from("conversations")
    .select("id")
    .eq("contact_id", lead.contact_id)
    .eq("channel", "whatsapp")
    .maybeSingle();
  if (!conversation) return [];

  const { data, error } = await db
    .from("whatsapp_messages")
    .select("*, sender:sent_by(id, email, full_name)")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to load WhatsApp messages: ${error.message}`);
  return (data ?? []) as unknown as WhatsAppMessageRow[];
}

export async function setWhatsAppConsent(
  db: SupabaseClient,
  params: { contactId: string; status: ConsentStatus; source: string }
): Promise<void> {
  const { error } = await db
    .from("contacts")
    .update({
      whatsapp_consent_status: params.status,
      whatsapp_consent_source: params.status === "unknown" ? null : params.source.slice(0, 200),
      whatsapp_consent_at: params.status === "unknown" ? null : new Date().toISOString(),
    })
    .eq("id", params.contactId);
  if (error) throw new Error(`Failed to update consent: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface SendTarget {
  contactId: string;
  recipient: string;
  toPhone: string;
  conversationId: string;
  lastInboundAt: string | null;
  firstContactedAt: string | null;
}

/** Everything both send paths check before touching the provider. */
async function prepareSend(admin: SupabaseClient, orgId: string, leadId: string): Promise<SendTarget> {
  const { data: lead, error } = await admin
    .from("leads")
    .select("id, contact_id, first_contacted_at, contact:contacts!leads_org_contact_fkey(phone_normalized, whatsapp_consent_status)")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load lead: ${error.message}`);
  if (!lead) throw new UserError("Lead not found.");

  const contact = (Array.isArray(lead.contact) ? lead.contact[0] : lead.contact) as
    | { phone_normalized: string | null; whatsapp_consent_status: ConsentStatus }
    | null;
  if (!contact?.phone_normalized) throw new UserError("This lead has no valid phone number to message.");

  const gate = checkSendAllowed(contact.whatsapp_consent_status);
  if (!gate.allowed) throw new UserError(gate.reason);

  const conversationId = await getOrCreateConversation(admin, orgId, lead.contact_id as string);
  const { data: conversation } = await admin
    .from("conversations")
    .select("last_inbound_at")
    .eq("id", conversationId)
    .single();

  return {
    contactId: lead.contact_id as string,
    recipient: toWhatsAppRecipient(contact.phone_normalized),
    toPhone: contact.phone_normalized,
    conversationId,
    lastInboundAt: (conversation?.last_inbound_at as string | null) ?? null,
    firstContactedAt: (lead.first_contacted_at as string | null) ?? null,
  };
}

interface RecordParams {
  orgId: string;
  leadId: string;
  target: SendTarget;
  sentBy: string;
  messageType: "template" | "text";
  body: string;
  template?: { id: string; name: string; language: string };
  outcome: { ok: true; providerMessageId: string } | { ok: false; code: SendFailureCode; error: string };
  runtime: WhatsAppRuntime;
  actorLabel: string;
}

async function recordOutbound(admin: SupabaseClient, p: RecordParams): Promise<SendResult> {
  const { error } = await admin.from("whatsapp_messages").insert({
    org_id: p.orgId,
    lead_id: p.leadId,
    conversation_id: p.target.conversationId,
    direction: "outbound",
    message_type: p.messageType,
    template_id: p.template?.id ?? null,
    template_name: p.template?.name ?? null,
    language: p.template?.language ?? null,
    rendered_body: p.body,
    to_phone: p.target.toPhone,
    wa_message_id: p.outcome.ok ? p.outcome.providerMessageId : null,
    status: p.outcome.ok ? "sent" : "failed",
    error: p.outcome.ok ? null : p.outcome.error,
    error_code: p.outcome.ok ? null : p.outcome.code,
    sent_by: p.sentBy,
  });
  if (error) throw new Error(`Failed to log WhatsApp message: ${error.message}`);

  await admin
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", p.target.conversationId);

  const label = p.messageType === "template" ? `WhatsApp sent: ${p.template?.name}` : "WhatsApp sent";
  const demo = p.runtime.mode === "demo" ? " (demo mode — not delivered)" : "";

  if (p.outcome.ok) {
    await logActivity(admin, {
      orgId: p.orgId,
      leadId: p.leadId,
      actorId: p.sentBy,
      type: "whatsapp_sent",
      title: `${label}${demo}`,
      description: p.body,
    });
    if (!p.target.firstContactedAt) {
      await admin
        .from("leads")
        .update({ first_contacted_at: new Date().toISOString() })
        .eq("id", p.leadId)
        .eq("org_id", p.orgId)
        .is("first_contacted_at", null);
    }
    if (p.runtime.mode === "live") await markConnected(admin, p.orgId, "whatsapp");
    return { status: "sent", messageId: p.outcome.providerMessageId };
  }

  // A failure is a first-class timeline event, not a silent log line: the
  // salesperson must know the customer did NOT get the message.
  await logActivity(admin, {
    orgId: p.orgId,
    leadId: p.leadId,
    actorId: p.sentBy,
    type: "whatsapp_failed",
    title: "WhatsApp message failed",
    description: p.outcome.error,
    metadata: { code: p.outcome.code },
  });
  // Only failures that say something about the *integration* (bad credentials,
  // provider outage) mark it failing. A number that isn't on WhatsApp, or a
  // closed window, is about the contact — it must not turn the admin's page red.
  if (p.runtime.mode === "live" && (p.outcome.code === "auth" || p.outcome.code === "other")) {
    await markFailing(admin, p.orgId, "whatsapp", p.outcome.error);
  }
  return { status: "failed", error: p.outcome.error, code: p.outcome.code };
}

/**
 * Sends an approved template. Works outside the 24-hour window (that's what
 * templates are for). The caller checks the acting user may access this lead;
 * everything here runs as the service role because the org's token is
 * unreadable to any other role.
 */
export async function sendTemplateMessage(
  admin: SupabaseClient,
  runtime: WhatsAppRuntime,
  params: { orgId: string; leadId: string; templateId: string; variableValues: string[]; sentByUserId: string }
): Promise<SendResult> {
  const { data: template } = await admin
    .from("whatsapp_templates")
    .select("id, name, language, status, body_text, variable_count")
    .eq("org_id", params.orgId)
    .eq("id", params.templateId)
    .maybeSingle();
  if (!template) throw new UserError("Unknown template. Sync templates and try again.");

  const approvalProblem = templateApprovalError(template as { name: string; status: string });
  if (approvalProblem) throw new UserError(approvalProblem);
  if (params.variableValues.length < (template.variable_count as number)) {
    throw new UserError("Fill in every template variable before sending.");
  }

  const target = await prepareSend(admin, params.orgId, params.leadId);
  const body = renderBody(template.body_text as string, params.variableValues);

  const outcome = await runtime.provider.sendTemplate(runtime.connection, {
    to: target.recipient,
    templateName: template.name as string,
    languageCode: template.language as string,
    bodyParameters: params.variableValues,
  });

  return recordOutbound(admin, {
    orgId: params.orgId,
    leadId: params.leadId,
    target,
    sentBy: params.sentByUserId,
    messageType: "template",
    body,
    template: { id: template.id as string, name: template.name as string, language: template.language as string },
    outcome,
    runtime,
    actorLabel: "template",
  });
}

/** Sends free text. Only inside the 24-hour window the customer opened by messaging us. */
export async function sendTextMessage(
  admin: SupabaseClient,
  runtime: WhatsAppRuntime,
  params: { orgId: string; leadId: string; body: string; sentByUserId: string }
): Promise<SendResult> {
  const body = params.body.trim();
  if (!body) throw new UserError("Write a message first.");
  if (body.length > 4096) throw new UserError("WhatsApp messages are limited to 4096 characters.");

  const target = await prepareSend(admin, params.orgId, params.leadId);
  if (!isWithinServiceWindow(target.lastInboundAt)) {
    throw new UserError(
      "The 24-hour reply window is closed — WhatsApp only allows an approved template until the customer messages you again."
    );
  }

  const outcome = await runtime.provider.sendText(runtime.connection, { to: target.recipient, body });

  return recordOutbound(admin, {
    orgId: params.orgId,
    leadId: params.leadId,
    target,
    sentBy: params.sentByUserId,
    messageType: "text",
    body,
    outcome,
    runtime,
    actorLabel: "text",
  });
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export type EventOutcome = "processed" | "duplicate" | "unmatched" | "ignored" | "failed";

async function resolveOrg(admin: SupabaseClient, provider: WhatsAppProvider, phoneNumberId: string): Promise<string | null> {
  // The demo provider addresses a tenant directly: `mock:<orgId>`.
  if (provider.isMock && phoneNumberId.startsWith("mock:")) {
    const orgId = phoneNumberId.slice("mock:".length);
    const { data } = await admin.from("organizations").select("id").eq("id", orgId).maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }

  const { data } = await admin
    .from("whatsapp_connections")
    .select("org_id")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

/** The lead a reply should land on: the contact's open lead, else their most recent one. */
export async function leadForContact(admin: SupabaseClient, orgId: string, contactId: string): Promise<string | null> {
  const { data } = await admin
    .from("leads")
    .select("id")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .order("closed_at", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function handleInbound(
  admin: SupabaseClient,
  orgId: string,
  event: InboundMessageEvent,
  log: Logger
): Promise<EventOutcome> {
  const phone = `+${event.from.replace(/^\+/, "")}`;
  const { data: contact } = await admin
    .from("contacts")
    .select("id, first_name")
    .eq("org_id", orgId)
    .or(`phone_normalized.eq.${phone},additional_phone_normalized.eq.${phone}`)
    .limit(1)
    .maybeSingle();

  if (!contact) {
    // We don't create contacts from strangers who message the number: that's a
    // lead-capture decision (click-to-WhatsApp ads), deliberately not in V1.
    log.info("whatsapp.inbound_unmatched", { orgId });
    return "unmatched";
  }

  const leadId = await leadForContact(admin, orgId, contact.id as string);
  if (!leadId) return "unmatched";

  const conversationId = await getOrCreateConversation(admin, orgId, contact.id as string);
  const body = event.text ?? `[${event.messageType} message]`;

  const { error } = await admin.from("whatsapp_messages").insert({
    org_id: orgId,
    lead_id: leadId,
    conversation_id: conversationId,
    direction: "inbound",
    message_type: "text",
    rendered_body: body,
    from_phone: phone,
    wa_message_id: event.providerMessageId,
    status: "received",
    created_at: event.occurredAt,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return "duplicate";
    throw new Error(`Failed to store the message: ${error.message}`);
  }

  await admin
    .from("conversations")
    .update({ last_inbound_at: event.occurredAt, last_message_at: event.occurredAt })
    .eq("id", conversationId);

  await logActivity(admin, {
    orgId,
    leadId,
    actorId: null,
    type: "whatsapp_received",
    title: `WhatsApp reply from ${event.senderName || (contact.first_name as string)}`,
    description: body,
  });

  if (isOptOutText(event.text)) {
    await setWhatsAppConsentAdmin(admin, contact.id as string, "customer replied with an opt-out keyword");
    await logActivity(admin, {
      orgId,
      leadId,
      actorId: null,
      type: "lead_updated",
      title: "Contact opted out of WhatsApp",
      description: "They replied STOP. No further WhatsApp messages will be sent.",
    });
  }

  return "processed";
}

async function setWhatsAppConsentAdmin(admin: SupabaseClient, contactId: string, source: string) {
  await admin
    .from("contacts")
    .update({
      whatsapp_consent_status: "opted_out",
      whatsapp_consent_source: source,
      whatsapp_consent_at: new Date().toISOString(),
    })
    .eq("id", contactId);
}

async function handleStatus(admin: SupabaseClient, orgId: string, event: StatusEvent): Promise<EventOutcome> {
  const { data: message } = await admin
    .from("whatsapp_messages")
    .select("id, lead_id, status, delivered_at, read_at")
    .eq("org_id", orgId)
    .eq("wa_message_id", event.providerMessageId)
    .maybeSingle();
  if (!message) return "unmatched";

  const current = message.status as MessageStatus;
  const next = nextMessageStatus(current, event.status);
  if (next === current) return "ignored"; // late or repeated receipt

  await admin
    .from("whatsapp_messages")
    .update({
      status: next,
      ...(next === "delivered" || next === "read" ? { delivered_at: message.delivered_at ?? event.occurredAt } : {}),
      ...(next === "read" ? { read_at: event.occurredAt } : {}),
      ...(next === "failed" ? { error: event.errorMessage ?? "WhatsApp could not deliver this message.", error_code: event.errorCode ?? null } : {}),
    })
    .eq("id", message.id);

  if (next === "failed") {
    await logActivity(admin, {
      orgId,
      leadId: message.lead_id as string,
      actorId: null,
      type: "whatsapp_failed",
      title: "WhatsApp message could not be delivered",
      description: event.errorMessage,
      metadata: { code: event.errorCode ?? null },
    });
  }
  return "processed";
}

/**
 * Applies a verified delivery: inbound messages and status receipts, each
 * guarded by an idempotency receipt so provider retries change nothing.
 */
export async function handleWhatsAppEvents(
  admin: SupabaseClient,
  params: { provider: WhatsAppProvider; events: WhatsAppEvent[]; requestId: string; log?: Logger }
): Promise<Array<{ providerMessageId: string; kind: WhatsAppEvent["kind"]; outcome: EventOutcome }>> {
  const log = params.log ?? logger.child({ provider: "whatsapp", requestId: params.requestId });
  const results: Array<{ providerMessageId: string; kind: WhatsAppEvent["kind"]; outcome: EventOutcome }> = [];

  for (const event of params.events) {
    const orgId = await resolveOrg(admin, params.provider, event.phoneNumberId);
    const eventKey = `${event.kind}:${event.providerMessageId}${event.kind === "status" ? `:${event.status}` : ""}`;

    if (!orgId) {
      log.warn("whatsapp.unknown_number", { phoneNumberId: event.phoneNumberId });
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome: "unmatched" });
      continue;
    }

    const receipt = await beginReceipt(admin, { provider: "whatsapp", eventKey, orgId, requestId: params.requestId });
    if (receipt.alreadyHandled) {
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome: "duplicate" });
      continue;
    }

    try {
      const outcome = event.kind === "message" ? await handleInbound(admin, orgId, event, log) : await handleStatus(admin, orgId, event);
      await finishReceipt(admin, receipt.id, { status: outcome === "failed" ? "failed" : outcome });
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome });
    } catch (error) {
      await finishReceipt(admin, receipt.id, { status: "failed", error });
      log.error("whatsapp.event_failed", { orgId, eventKey, error });
      results.push({ providerMessageId: event.providerMessageId, kind: event.kind, outcome: "failed" });
    }
  }

  return results;
}
