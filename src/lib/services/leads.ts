import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CountryCode } from "libphonenumber-js/min";
import type { SessionContext } from "@/lib/auth/session";
import type { LeadFormInput } from "@/lib/validation/lead";
import { contactIdentity } from "@/lib/domain/contact";
import { localDayBounds, startOfDayUtc } from "@/lib/domain/due";
import { checkStageMove } from "@/lib/domain/opportunity";
import { permissions } from "@/lib/domain/permissions";
import { DEFAULT_PHONE_COUNTRY } from "@/lib/domain/phone";
import { logActivity } from "@/lib/services/activities";
import { recordAudit } from "@/lib/services/audit";
import { captureLead, CaptureError, type CaptureResult } from "@/lib/services/capture";
import { updateContact } from "@/lib/services/contacts";
import { getOrgTimezone } from "@/lib/services/settings";

export type LeadStateFilter = "open" | "won" | "lost";
export type LeadDueFilter = "overdue" | "today";

export interface LeadFilters {
  search?: string;
  statusId?: string;
  /** A user id, or `unassigned`. */
  assignedTo?: string;
  source?: string;
  /** Meta campaign id — narrows the list to leads produced by that campaign. */
  campaignId?: string;
  priority?: string;
  /** open / won / lost, derived from the stage's flags. */
  state?: LeadStateFilter;
  /** `YYYY-MM-DD` in the org's timezone, inclusive. */
  createdFrom?: string;
  createdTo?: string;
  /** Based on the earliest pending follow-up. */
  due?: LeadDueFilter;
  /** Open leads nobody has called or messaged yet. */
  uncontacted?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_SEARCH_TOKENS = 5;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds the PostgREST `or=` clauses for a search box. Each whitespace-
 * separated word must match somewhere (so "Vikram Singh" finds Vikram Singh),
 * and a number-looking word matches phone digits regardless of how it was
 * typed. Characters that are syntax in a PostgREST filter (`, ( ) " \ * %`)
 * are dropped so a search term can't rewrite the query — it can only ever
 * narrow results, never add clauses.
 */
export function buildSearchClauses(term: string): string[] {
  const cleaned = term.replace(/[,()"\\*%]/g, " ").trim();

  // A whole phone number typed with spaces or punctuation ("+91 98974 94788")
  // is one digit string, not three words.
  const wholeDigits = cleaned.replace(/\D/g, "");
  if (wholeDigits.length >= 3 && /^[\d\s+\-().]+$/.test(cleaned)) {
    return [`phone.ilike.%${wholeDigits}%`];
  }

  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => {
      const digits = token.replace(/\D/g, "");
      const looksLikePhone = digits.length >= 3 && /^[+\d\-().]+$/.test(token);
      return looksLikePhone
        ? `phone.ilike.%${digits}%`
        : `first_name.ilike.%${token}%,last_name.ilike.%${token}%,email.ilike.%${token}%`;
    });
}

export async function listLeads(db: SupabaseClient, session: SessionContext, filters: LeadFilters = {}) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const timezone = await getOrgTimezone(db, session.orgId);

  // Relationship hints (`table!fk_name`) are required wherever two foreign keys
  // connect the same pair of tables: the plain lead_id FK (used for embeds)
  // and the composite (org_id, lead_id) FK that stops cross-tenant references.
  //
  // An inner join on attribution when filtering by campaign, so the filter
  // also excludes leads that have no Meta attribution at all.
  const attributionJoin = filters.campaignId
    ? "attribution:meta_lead_attribution!meta_lead_attribution_lead_id_fkey!inner(campaign_id, campaign_name, ad_name, platform)"
    : "attribution:meta_lead_attribution!meta_lead_attribution_lead_id_fkey(campaign_id, campaign_name, ad_name, platform)";

  let query = db
    .from("leads")
    .select(
      `*, status:status_id!inner(*), assignee:assigned_to(id, email, full_name), followups!followups_lead_id_fkey(id, due_date, due_time, status), activities!activities_lead_id_fkey(id, created_at), ${attributionJoin}`,
      { count: "exact" }
    )
    .eq("org_id", session.orgId);

  if (!permissions.canViewAllLeads(session.role)) {
    // Their own leads, ones they created, and the unassigned pool they can claim from.
    query = query.or(`assigned_to.eq.${session.user.id},created_by.eq.${session.user.id},assigned_to.is.null`);
  }

  if (filters.search) {
    for (const clause of buildSearchClauses(filters.search)) query = query.or(clause);
  }
  if (filters.statusId) query = query.eq("status_id", filters.statusId);
  if (filters.assignedTo === "unassigned") query = query.is("assigned_to", null);
  else if (filters.assignedTo) query = query.eq("assigned_to", filters.assignedTo);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.campaignId) query = query.eq("meta_lead_attribution.campaign_id", filters.campaignId);

  if (filters.state === "won") query = query.eq("status.is_won", true);
  else if (filters.state === "lost") query = query.eq("status.is_lost", true);
  else if (filters.state === "open") query = query.eq("status.is_won", false).eq("status.is_lost", false);

  if (filters.createdFrom && DATE_ONLY.test(filters.createdFrom)) {
    query = query.gte("created_at", startOfDayUtc(filters.createdFrom, timezone).toISOString());
  }
  if (filters.createdTo && DATE_ONLY.test(filters.createdTo)) {
    const [y, m, d] = filters.createdTo.split("-").map(Number);
    const dayAfter = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    query = query.lt("created_at", startOfDayUtc(dayAfter, timezone).toISOString());
  }

  if (filters.due) {
    const now = new Date();
    if (filters.due === "overdue") {
      query = query.lt("next_action_at", now.toISOString());
    } else {
      query = query
        .gte("next_action_at", now.toISOString())
        // <= end: a follow-up with no time is due by the day's end, which is
        // exactly the boundary instant.
        .lte("next_action_at", localDayBounds(now, timezone).end.toISOString());
    }
  }

  if (filters.uncontacted) {
    query = query.is("first_contacted_at", null).eq("status.is_won", false).eq("status.is_lost", false);
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error) throw new Error(`Failed to list leads: ${error.message}`);

  return { leads: data ?? [], total: count ?? 0, page, pageSize };
}

export async function getLead(db: SupabaseClient, leadId: string) {
  const { data, error } = await db
    .from("leads")
    .select("*, status:status_id(*), assignee:assigned_to(id, email, full_name), contact:contacts!leads_org_contact_fkey(*)")
    .eq("id", leadId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load lead: ${error.message}`);
  return data;
}

export async function getLeadTimeline(db: SupabaseClient, leadId: string) {
  const [notes, meetings, followups, activities, calls] = await Promise.all([
    db
      .from("notes")
      .select("*, author:author_id(id, email, full_name)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
    db
      .from("meetings")
      .select("*, salesperson:salesperson_id(id, email, full_name)")
      .eq("lead_id", leadId)
      .order("scheduled_start", { ascending: false }),
    db
      .from("followups")
      .select("*, assignee:assigned_to(id, email, full_name)")
      .eq("lead_id", leadId)
      .order("due_date", { ascending: true }),
    db
      .from("activities")
      .select("*, actor:actor_id(id, email, full_name)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
    db
      .from("call_logs")
      .select("*, caller:caller_id(id, email, full_name)")
      .eq("lead_id", leadId)
      .order("called_at", { ascending: false }),
  ]);

  for (const result of [notes, meetings, followups, activities, calls]) {
    if (result.error) throw new Error(`Failed to load lead timeline: ${result.error.message}`);
  }

  return {
    notes: notes.data ?? [],
    meetings: meetings.data ?? [],
    followups: followups.data ?? [],
    activities: activities.data ?? [],
    calls: calls.data ?? [],
  };
}

/**
 * Manual lead entry. A thin wrapper over `captureLead` — the same door Meta
 * and the mock source use — so a person typed in by hand is normalized and
 * deduped exactly like one that arrived from an ad.
 */
export async function createLead(
  db: SupabaseClient,
  session: SessionContext,
  input: LeadFormInput
): Promise<CaptureResult> {
  return captureLead(
    db,
    { orgId: session.orgId, userId: session.user.id, role: session.role },
    {
      firstName: input.first_name,
      lastName: input.last_name,
      phone: input.phone,
      additionalPhone: input.additional_phone,
      email: input.email,
      source: input.source,
      assigneeId: input.assigned_to || null,
      priority: input.priority,
      value: input.value ?? null,
      strictPhone: true,
      timeline: {
        type: "lead_created",
        title: "Lead created",
        description: `${input.first_name} ${input.last_name ?? ""}`.trim() + " was added to the CRM.",
      },
    }
  );
}

/**
 * Edits the person (contact) and the sales attempt (opportunity) together.
 * The lead's name/phone/email are a database-maintained copy of the contact,
 * so the contact is the row that actually changes.
 */
export async function updateLead(
  db: SupabaseClient,
  session: SessionContext,
  leadId: string,
  input: LeadFormInput
) {
  const { data: lead, error: leadError } = await db
    .from("leads")
    .select("id, contact_id, contact:contacts!leads_org_contact_fkey(instagram_user_id)")
    .eq("id", leadId)
    .eq("org_id", session.orgId)
    .maybeSingle();
  if (leadError) throw new Error(`Failed to load lead: ${leadError.message}`);
  if (!lead) throw new Error("Lead not found.");

  // Someone who only ever DMed us on Instagram has neither; anyone else needs one.
  const contact = (Array.isArray(lead.contact) ? lead.contact[0] : lead.contact) as { instagram_user_id: string | null } | null;
  if (!input.phone?.trim() && !input.email?.trim() && !contact?.instagram_user_id) {
    throw new CaptureError("Provide at least a phone number or an email.");
  }

  const country = await getDefaultCountry(db, session.orgId);
  const identity = contactIdentity(
    { phone: input.phone, additionalPhone: input.additional_phone, email: input.email },
    country
  );
  if (input.phone?.trim() && !identity.phoneNormalized) {
    throw new CaptureError("Enter a valid phone number, including the country code if it isn't Indian.");
  }

  await updateContact(
    db,
    lead.contact_id as string,
    {
      firstName: input.first_name,
      lastName: input.last_name,
      phone: input.phone,
      additionalPhone: input.additional_phone,
      email: input.email,
      source: input.source,
    },
    identity
  );

  const { error } = await db
    .from("leads")
    .update({
      source: input.source,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
    })
    .eq("id", leadId)
    .eq("org_id", session.orgId);
  if (error) throw new Error(`Failed to update lead: ${error.message}`);

  await logActivity(db, {
    orgId: session.orgId,
    leadId,
    actorId: session.user.id,
    type: "lead_updated",
    title: "Lead details updated",
  });
}

/**
 * Manual assignment (V1). Managers/admins assign anyone; a salesperson may
 * only claim a lead nobody owns (DECISIONS D-012). The database enforces the
 * same rule for direct API calls; checking here gives a readable error and
 * verifies the assignee actually belongs to this org.
 */
export async function assignLead(
  db: SupabaseClient,
  session: SessionContext,
  leadId: string,
  assigneeId: string
) {
  const { data: lead, error: leadError } = await db
    .from("leads")
    .select("id, assigned_to")
    .eq("id", leadId)
    .eq("org_id", session.orgId)
    .maybeSingle();
  if (leadError) throw new Error(`Failed to load lead: ${leadError.message}`);
  if (!lead) throw new Error("Lead not found.");

  if (!permissions.canAssignLead(session.role, session.user.id, lead, assigneeId)) {
    throw new CaptureError(
      session.role === "salesperson"
        ? "Only a manager or admin can reassign a lead. You can claim leads that have no owner."
        : "You don't have permission to assign leads."
    );
  }

  const { data: member } = await db
    .from("organization_members")
    .select("is_active, profile:user_id(full_name, email)")
    .eq("org_id", session.orgId)
    .eq("user_id", assigneeId)
    .maybeSingle();
  if (!member) throw new CaptureError("That person is not a member of this organization.");
  if (member.is_active === false) throw new CaptureError("That person's account is deactivated.");

  const profile = Array.isArray(member.profile) ? member.profile[0] : member.profile;
  const name = profile?.full_name || profile?.email || "team member";

  const { error } = await db
    .from("leads")
    .update({ assigned_to: assigneeId })
    .eq("id", leadId)
    .eq("org_id", session.orgId);
  if (error) throw new Error(`Failed to assign lead: ${error.message}`);

  await logActivity(db, {
    orgId: session.orgId,
    leadId,
    actorId: session.user.id,
    type: "lead_assigned",
    title: "Assigned to salesperson",
    description: `Lead assigned to ${name}.`,
    metadata: { from: lead.assigned_to, to: assigneeId },
  });
}

/**
 * Moves an opportunity to another stage of its pipeline. The single writer of
 * stage changes (list view, detail page and Kanban all come here), so every
 * move produces a timeline entry, and a move into a lost stage always carries
 * a reason.
 */
export async function changeLeadStage(
  db: SupabaseClient,
  session: SessionContext,
  leadId: string,
  toStageId: string,
  lostReason?: string | null
) {
  const [{ data: lead, error: leadError }, { data: target, error: targetError }] = await Promise.all([
    db
      .from("leads")
      .select("id, pipeline_id, status:status_id(id, label)")
      .eq("id", leadId)
      .eq("org_id", session.orgId)
      .maybeSingle(),
    db
      .from("lead_statuses")
      .select("id, label, pipeline_id, is_won, is_lost")
      .eq("id", toStageId)
      .eq("org_id", session.orgId)
      .maybeSingle(),
  ]);

  if (leadError) throw new Error(`Failed to load lead: ${leadError.message}`);
  if (targetError) throw new Error(`Failed to load stage: ${targetError.message}`);
  if (!lead) throw new Error("Lead not found.");
  if (!target) throw new CaptureError("That stage doesn't exist.");
  if (target.pipeline_id !== lead.pipeline_id) throw new CaptureError("That stage belongs to a different pipeline.");

  const check = checkStageMove(target, lostReason);
  if (!check.ok) throw new CaptureError(check.error);

  const from = Array.isArray(lead.status) ? lead.status[0] : lead.status;
  if (from?.id === target.id) return; // no-op: not worth a timeline entry

  const { error } = await db
    .from("leads")
    .update({ status_id: target.id, lost_reason: check.lostReason })
    .eq("id", leadId)
    .eq("org_id", session.orgId);
  if (error) throw new Error(`Failed to change stage: ${error.message}`);

  await logActivity(db, {
    orgId: session.orgId,
    leadId,
    actorId: session.user.id,
    type: "status_changed",
    title: `Stage changed: ${from?.label ?? "Unknown"} → ${target.label}`,
    description: check.lostReason ? `Reason: ${check.lostReason}` : undefined,
    metadata: { from: from?.label ?? null, to: target.label, from_id: from?.id ?? null, to_id: target.id },
  });
}

export async function deleteLead(db: SupabaseClient, session: SessionContext, leadId: string) {
  if (!permissions.canDeleteLead(session.role)) {
    throw new CaptureError("You don't have permission to delete leads.");
  }

  const { data: lead } = await db
    .from("leads")
    .select("id, first_name, last_name")
    .eq("id", leadId)
    .eq("org_id", session.orgId)
    .maybeSingle();
  if (!lead) throw new Error("Lead not found.");

  const { error } = await db.from("leads").delete().eq("id", leadId).eq("org_id", session.orgId);
  if (error) throw new Error(`Failed to delete lead: ${error.message}`);

  // The lead's own timeline goes with it, so the deletion is recorded where it survives.
  await recordAudit(db, {
    orgId: session.orgId,
    actorId: session.user.id,
    action: "lead.deleted",
    entityType: "lead",
    entityId: leadId,
    summary: `Deleted lead ${`${lead.first_name} ${lead.last_name ?? ""}`.trim()}`,
  });
}

async function getDefaultCountry(db: SupabaseClient, orgId: string): Promise<CountryCode> {
  const { data } = await db.from("organizations").select("default_country").eq("id", orgId).maybeSingle();
  return ((data?.default_country as CountryCode | undefined) ?? DEFAULT_PHONE_COUNTRY) as CountryCode;
}
