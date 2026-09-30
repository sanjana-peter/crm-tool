import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MetaGraphClient } from "@/lib/integrations/meta/client";
import { requireMetaConfig } from "@/lib/integrations/meta/config";
import { mapLeadContact, toInboundLead } from "@/lib/integrations/meta/mapping";
import type { MetaLead, MetaPage } from "@/lib/integrations/meta/types";
import { assignmentStrategyFor } from "@/lib/services/assignment";
import { captureLead, inboundToCaptureInput } from "@/lib/services/capture";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";

export interface MetaConnection {
  id: string;
  org_id: string;
  meta_user_id: string;
  meta_user_name: string | null;
  scopes: string[];
  token_expires_at: string | null;
  default_assignee_id: string | null;
  connected_at: string;
}

export interface MetaPageRecord {
  id: string;
  org_id: string;
  page_id: string;
  page_name: string;
  instagram_account_id: string | null;
  webhook_subscribed: boolean;
  is_active: boolean;
}

export type IngestOutcome =
  | { status: "processed"; leadId: string }
  | { status: "duplicate"; leadId: string | null };

export function createGraphClient() {
  return new MetaGraphClient(requireMetaConfig());
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getConnection(
  supabase: SupabaseClient,
  orgId: string
): Promise<MetaConnection | null> {
  const { data, error } = await supabase
    .from("meta_connections")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load Meta connection: ${error.message}`);
  return (data as MetaConnection | null) ?? null;
}

export async function listPages(
  supabase: SupabaseClient,
  orgId: string
): Promise<MetaPageRecord[]> {
  const { data, error } = await supabase
    .from("meta_pages")
    .select("*")
    .eq("org_id", orgId)
    .order("page_name");

  if (error) throw new Error(`Failed to load Meta pages: ${error.message}`);
  return (data ?? []) as MetaPageRecord[];
}

/**
 * Persists a completed OAuth handshake: the long-lived user token, the account
 * identity, and every Page the user granted us, each with its Page token.
 *
 * Requires an admin client — the token tables are unreadable and unwritable
 * through RLS by design.
 */
export async function saveConnection(
  admin: SupabaseClient,
  params: {
    orgId: string;
    userId: string;
    metaUserId: string;
    metaUserName: string | null;
    userAccessToken: string;
    tokenExpiresAt: string | null;
    scopes: string[];
    pages: MetaPage[];
  }
): Promise<void> {
  const { error: connectionError } = await admin.from("meta_connections").upsert(
    {
      org_id: params.orgId,
      meta_user_id: params.metaUserId,
      meta_user_name: params.metaUserName,
      scopes: params.scopes,
      token_expires_at: params.tokenExpiresAt,
      connected_by: params.userId,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "org_id" }
  );
  if (connectionError) throw new Error(`Failed to save connection: ${connectionError.message}`);

  const { error: tokenError } = await admin.from("meta_user_tokens").upsert(
    {
      org_id: params.orgId,
      user_access_token: encryptSecret(params.userAccessToken),
      expires_at: params.tokenExpiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" }
  );
  if (tokenError) throw new Error(`Failed to save user token: ${tokenError.message}`);

  for (const page of params.pages) {
    // `page_id` is globally unique, so a Page already feeding another org is
    // rejected here rather than silently re-pointed.
    const { data: existing } = await admin
      .from("meta_pages")
      .select("org_id")
      .eq("page_id", page.id)
      .maybeSingle();

    if (existing && existing.org_id !== params.orgId) continue;

    const { error: pageError } = await admin.from("meta_pages").upsert(
      {
        org_id: params.orgId,
        page_id: page.id,
        page_name: page.name,
        instagram_account_id: page.instagram_business_account?.id ?? null,
      },
      { onConflict: "page_id" }
    );
    if (pageError) throw new Error(`Failed to save page ${page.name}: ${pageError.message}`);

    const { error: pageTokenError } = await admin.from("meta_page_tokens").upsert(
      {
        page_id: page.id,
        org_id: params.orgId,
        page_access_token: encryptSecret(page.access_token),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "page_id" }
    );
    if (pageTokenError) {
      throw new Error(`Failed to save page token: ${pageTokenError.message}`);
    }
  }
}

export async function disconnect(admin: SupabaseClient, orgId: string): Promise<void> {
  // Tokens and pages cascade from the org; delete tokens explicitly so no
  // credential outlives the connection even if a cascade path changes.
  await admin.from("meta_page_tokens").delete().eq("org_id", orgId);
  await admin.from("meta_user_tokens").delete().eq("org_id", orgId);
  await admin.from("meta_pages").delete().eq("org_id", orgId);
  await admin.from("meta_lead_forms").delete().eq("org_id", orgId);
  const { error } = await admin.from("meta_connections").delete().eq("org_id", orgId);
  if (error) throw new Error(`Failed to disconnect: ${error.message}`);
}

export async function setPageActive(
  supabase: SupabaseClient,
  orgId: string,
  pageId: string,
  isActive: boolean
): Promise<void> {
  const { error } = await supabase
    .from("meta_pages")
    .update({ is_active: isActive })
    .eq("org_id", orgId)
    .eq("page_id", pageId);
  if (error) throw new Error(`Failed to update page: ${error.message}`);
}

export async function setDefaultAssignee(
  supabase: SupabaseClient,
  orgId: string,
  assigneeId: string | null
): Promise<void> {
  const { error } = await supabase
    .from("meta_connections")
    .update({ default_assignee_id: assigneeId })
    .eq("org_id", orgId);
  if (error) throw new Error(`Failed to set default assignee: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Token + org resolution (service role only)
// ---------------------------------------------------------------------------

export async function getPageToken(
  admin: SupabaseClient,
  pageId: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("meta_page_tokens")
    .select("page_access_token")
    .eq("page_id", pageId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load page token: ${error.message}`);
  return data?.page_access_token ? decryptSecret(data.page_access_token) : null;
}

export async function getUserToken(admin: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("meta_user_tokens")
    .select("user_access_token")
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load user token: ${error.message}`);
  return data?.user_access_token ? decryptSecret(data.user_access_token) : null;
}

/** Maps an inbound webhook's page_id to the org that owns that Page. */
export async function resolveOrgByPageId(
  admin: SupabaseClient,
  pageId: string
): Promise<{ orgId: string; isActive: boolean } | null> {
  const { data, error } = await admin
    .from("meta_pages")
    .select("org_id, is_active")
    .eq("page_id", pageId)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve org for page: ${error.message}`);
  if (!data) return null;
  return { orgId: data.org_id as string, isActive: data.is_active as boolean };
}

// ---------------------------------------------------------------------------
// Webhook event log
// ---------------------------------------------------------------------------

export async function recordWebhookEvent(
  admin: SupabaseClient,
  params: {
    orgId: string | null;
    pageId: string | null;
    formId: string | null;
    leadgenId: string | null;
    signatureValid: boolean;
    payload: unknown;
  }
): Promise<string> {
  const { data, error } = await admin
    .from("meta_webhook_events")
    .insert({
      org_id: params.orgId,
      page_id: params.pageId,
      form_id: params.formId,
      leadgen_id: params.leadgenId,
      signature_valid: params.signatureValid,
      payload: params.payload ?? {},
      status: "received",
      attempts: 1,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to record webhook event: ${error.message}`);
  return data.id as string;
}

export async function markWebhookEvent(
  admin: SupabaseClient,
  eventId: string,
  update: {
    status: "processed" | "duplicate" | "ignored" | "failed";
    error?: string | null;
    leadId?: string | null;
    orgId?: string | null;
  }
): Promise<void> {
  await admin
    .from("meta_webhook_events")
    .update({
      status: update.status,
      error: update.error ?? null,
      lead_id: update.leadId ?? null,
      ...(update.orgId ? { org_id: update.orgId } : {}),
      processed_at: new Date().toISOString(),
    })
    .eq("id", eventId);
}

export async function listWebhookEvents(
  supabase: SupabaseClient,
  orgId: string,
  limit = 50
) {
  const { data, error } = await supabase
    .from("meta_webhook_events")
    .select("*")
    .eq("org_id", orgId)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load webhook events: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Lead forms
// ---------------------------------------------------------------------------

export async function syncLeadForms(
  admin: SupabaseClient,
  orgId: string
): Promise<{ synced: number }> {
  const graph = createGraphClient();
  const pages = await listPages(admin, orgId);
  let synced = 0;

  for (const page of pages) {
    const token = await getPageToken(admin, page.page_id);
    if (!token) continue;

    const forms = await graph.listLeadForms(page.page_id, token);
    for (const form of forms) {
      const { error } = await admin.from("meta_lead_forms").upsert(
        {
          org_id: orgId,
          page_id: page.page_id,
          form_id: form.id,
          form_name: form.name,
          status: form.status ?? null,
          leads_count: form.leads_count ?? null,
        },
        { onConflict: "org_id,form_id" }
      );
      if (error) throw new Error(`Failed to save lead form: ${error.message}`);
      synced += 1;
    }
  }

  return { synced };
}

export async function listLeadForms(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("meta_lead_forms")
    .select("*")
    .eq("org_id", orgId)
    .order("form_name");

  if (error) throw new Error(`Failed to load lead forms: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Turns one Meta lead into a CRM lead, its ad attribution, and a timeline
 * entry — by handing a normalized `InboundLead` to `captureLead`, the same
 * door manual entry uses. Idempotent: `lead_inquiries` (and the unique index
 * on `leads`) mean a webhook retry or an overlapping backfill resolves to
 * `duplicate` instead of creating a second lead, and a person who submits a
 * second form joins their existing open lead instead of duplicating it.
 */
export async function ingestMetaLead(
  admin: SupabaseClient,
  params: {
    orgId: string;
    pageId: string | null;
    lead: MetaLead;
    defaultAssigneeId: string | null;
  }
): Promise<IngestOutcome> {
  const { orgId, pageId, lead } = params;

  const contact = mapLeadContact(lead.field_data ?? []);
  if (!contact.email && !contact.phone) {
    throw new Error(
      `Meta lead ${lead.id} has neither an email nor a phone number; the form must collect at least one.`
    );
  }

  const result = await captureLead(
    admin,
    { orgId, userId: null, role: null },
    inboundToCaptureInput(toInboundLead(lead), { assigneeId: params.defaultAssigneeId }),
    {
      // A connection-level default assignee wins; otherwise the org's strategy (round-robin or none).
      assignment: await assignmentStrategyFor(admin, orgId),
      // Meta's ad attribution is Meta-specific, so the core doesn't know it
      // exists: it hands us the outcome and we store our own extras. Runs for
      // `duplicate` too, so a delivery that died after creating the lead but
      // before this insert is repaired on Meta's retry (the upsert is a no-op
      // when the row is already there).
      onCaptured: async (captured) => {
        if (captured.outcome === "merged" || captured.outcome === "existing_restricted") return;
        if (captured.outcome === "duplicate" && !captured.createdOpportunity) return;
        if (!captured.leadId) return;
        await saveAttribution(admin, orgId, captured.leadId, pageId, lead);
      },
    }
  );

  switch (result.outcome) {
    case "created":
    case "merged":
      return { status: "processed", leadId: result.leadId };
    case "duplicate":
      return { status: "duplicate", leadId: result.leadId };
    case "existing_restricted":
      // Unreachable for a system actor; kept so the switch stays exhaustive.
      throw new Error("Meta ingestion was blocked by an ownership restriction.");
  }
}

async function saveAttribution(
  admin: SupabaseClient,
  orgId: string,
  leadId: string,
  pageId: string | null,
  lead: MetaLead
): Promise<void> {
  const { error } = await admin.from("meta_lead_attribution").upsert(
    {
      lead_id: leadId,
      org_id: orgId,
      leadgen_id: lead.id,
      page_id: pageId,
      form_id: lead.form_id ?? null,
      form_name: null,
      campaign_id: lead.campaign_id ?? null,
      campaign_name: lead.campaign_name ?? null,
      adset_id: lead.adset_id ?? null,
      adset_name: lead.adset_name ?? null,
      ad_id: lead.ad_id ?? null,
      ad_name: lead.ad_name ?? null,
      platform: lead.platform ?? null,
      is_organic: lead.is_organic ?? false,
      field_data: lead.field_data ?? [],
      meta_created_time: lead.created_time ?? null,
    },
    { onConflict: "lead_id", ignoreDuplicates: true }
  );
  if (error) throw new Error(`Failed to save lead attribution: ${error.message}`);
}

/** Backfills the form's lead_name onto attribution rows created by a backfill run. */
export async function setAttributionFormName(
  admin: SupabaseClient,
  leadId: string,
  formName: string | null
): Promise<void> {
  if (!formName) return;
  await admin.from("meta_lead_attribution").update({ form_name: formName }).eq("lead_id", leadId);
}

export async function getLeadAttribution(supabase: SupabaseClient, leadId: string) {
  const { data, error } = await supabase
    .from("meta_lead_attribution")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load lead attribution: ${error.message}`);
  return data;
}

/** Distinct campaigns that have produced leads, for the leads-list filter. */
export async function listCampaigns(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("meta_lead_attribution")
    .select("campaign_id, campaign_name")
    .eq("org_id", orgId)
    .not("campaign_id", "is", null);

  if (error) throw new Error(`Failed to load campaigns: ${error.message}`);

  const seen = new Map<string, string>();
  for (const row of data ?? []) {
    const id = row.campaign_id as string;
    if (!seen.has(id)) seen.set(id, (row.campaign_name as string) ?? id);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}
