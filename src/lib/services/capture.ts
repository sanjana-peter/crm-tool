import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CountryCode } from "libphonenumber-js/min";
import { UserError } from "@/lib/domain/errors";
import { manualAssignment, type AssignmentStrategy } from "@/lib/domain/assignment";
import { contactIdentity } from "@/lib/domain/contact";
import { DEFAULT_PHONE_COUNTRY } from "@/lib/domain/phone";
import { permissions, type OrgRole } from "@/lib/domain/permissions";
import type { OpportunityPriority } from "@/lib/domain/opportunity";
import type { InboundLead } from "@/lib/ports/lead-source";
import type { ActivityType } from "@/lib/types/domain";
import { logActivity } from "@/lib/services/activities";
import { createContact, fillMissingContactFields, findContactForCapture } from "@/lib/services/contacts";
import { entryStage, getDefaultPipeline } from "@/lib/services/pipelines";

const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

/** Who is capturing. `userId: null` = the system (a webhook, an import). */
export interface CaptureActor {
  orgId: string;
  userId: string | null;
  role: OrgRole | null;
}

export interface CaptureInput {
  firstName: string;
  lastName?: string | null;
  phone?: string | null;
  additionalPhone?: string | null;
  email?: string | null;
  source: string;
  sourceDetail?: string | null;
  tags?: string[];
  assigneeId?: string | null;
  priority?: OpportunityPriority;
  value?: number | null;
  /** Provider + id: replaying the same external event is then a no-op. */
  external?: { provider: string; id: string } | null;
  receivedAt?: string | null;
  /** A person typing in a phone number should be told it's wrong; a webhook should not be rejected for it. */
  strictPhone?: boolean;
  timeline: { type: ActivityType; title: string; description?: string; metadata?: Record<string, unknown> };
}

export type CaptureResult =
  /** A new contact-and-opportunity was created. */
  | { outcome: "created"; contactId: string; leadId: string; assigneeId: string | null }
  /** The person already has an open opportunity; this inquiry joined its timeline. */
  | { outcome: "merged"; contactId: string; leadId: string }
  /** This exact external event was already captured. Nothing was written. */
  | { outcome: "duplicate"; contactId: string | null; leadId: string | null; createdOpportunity: boolean }
  /** The person is already an active lead owned by someone else; the caller may not touch it. */
  | { outcome: "existing_restricted"; contactId: string; assigneeId: string | null };

/** A problem the caller can fix and should be shown (bad phone, assignee not on the team). */
export class CaptureError extends UserError {}

export interface CaptureDeps {
  assignment?: AssignmentStrategy;
  /**
   * Runs after any outcome that has a lead (`created`, `merged`, `duplicate`),
   * so an integration can store provider-specific extras (Meta's ad
   * attribution) without the core knowing what they are. Must be idempotent:
   * it also runs when a retried delivery resolves to `duplicate`.
   */
  onCaptured?: (result: CaptureResult) => Promise<void>;
}

/**
 * The one door every new lead comes through — manual entry, the Meta
 * webhook, a backfill, the mock source. Sharing it means a person is
 * normalized, deduped and timeline-logged identically no matter how they
 * arrived (docs/ARCHITECTURE.md).
 *
 *   1. Replayed external event?           → `duplicate`, write nothing.
 *   2. Find the contact by normalized phone/email, else create one.
 *   3. Contact already has an open lead?  → `merged` (or `existing_restricted`
 *      if the caller isn't allowed to see it).
 *   4. Otherwise create the opportunity in the pipeline's entry stage.
 */
export async function captureLead(
  db: SupabaseClient,
  actor: CaptureActor,
  input: CaptureInput,
  deps: CaptureDeps = {}
): Promise<CaptureResult> {
  const country = await getDefaultCountry(db, actor.orgId);
  const identity = contactIdentity(
    { phone: input.phone, additionalPhone: input.additionalPhone, email: input.email },
    country
  );

  if (!input.phone?.trim() && !input.email?.trim()) {
    throw new CaptureError("Provide at least a phone number or an email.");
  }
  if (input.strictPhone && input.phone?.trim() && !identity.phoneNormalized) {
    throw new CaptureError("Enter a valid phone number, including the country code if it isn't Indian.");
  }

  const finish = async (result: CaptureResult) => {
    if (result.outcome !== "existing_restricted") await deps.onCaptured?.(result);
    return result;
  };

  // 1. Idempotency.
  if (input.external) {
    const replay = await findInquiry(db, actor.orgId, input.external.provider, input.external.id);
    if (replay) return finish({ outcome: "duplicate", ...replay });
  }

  // 2. Contact.
  const existingContactId = await findContactForCapture(db, actor.orgId, identity);
  const contact =
    existingContactId !== null
      ? { id: existingContactId, created: false }
      : await createContact(
          db,
          actor.orgId,
          {
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
            additionalPhone: input.additionalPhone,
            email: input.email,
            source: input.source,
            sourceDetail: input.sourceDetail,
            tags: input.tags,
            createdBy: actor.userId,
          },
          identity
        );

  if (!contact.created) await fillMissingContactFields(db, contact.id, input, identity);

  // 3. Existing open opportunity for this person.
  const open = await findOpenOpportunity(db, actor.orgId, contact.id);
  if (open) {
    const mayWrite =
      actor.role !== "salesperson" || open.assignedTo === actor.userId || open.createdBy === actor.userId;
    if (!mayWrite) {
      return { outcome: "existing_restricted", contactId: contact.id, assigneeId: open.assignedTo };
    }

    // Racing redeliveries of one event can arrive here after the winner has
    // already created this very lead (or recorded this inquiry). That's a
    // replay, not a new inquiry: writing another timeline entry would
    // duplicate it.
    if (input.external) {
      const isSameEvent = await leadWasCreatedBy(db, actor.orgId, open.leadId, input.external);
      if (isSameEvent) {
        return finish({ outcome: "duplicate", contactId: contact.id, leadId: open.leadId, createdOpportunity: true });
      }
    }

    const recorded = await recordInquiry(db, actor, input, contact.id, open.leadId, false);
    if (!recorded && input.external) {
      const replay = await findInquiry(db, actor.orgId, input.external.provider, input.external.id);
      return finish({
        outcome: "duplicate",
        contactId: contact.id,
        leadId: replay?.leadId ?? open.leadId,
        createdOpportunity: replay?.createdOpportunity ?? false,
      });
    }

    await logActivity(db, {
      orgId: actor.orgId,
      leadId: open.leadId,
      actorId: actor.userId,
      type: "lead_inquiry_received",
      title: `New inquiry: ${input.timeline.title}`,
      description: input.timeline.description,
      metadata: { ...input.timeline.metadata, source: input.source },
    });
    return finish({ outcome: "merged", contactId: contact.id, leadId: open.leadId });
  }

  // 4. New opportunity.
  const strategy = deps.assignment ?? manualAssignment;
  const requestedAssigneeId = input.assigneeId ?? null;
  const assigneeId = await strategy.pickAssignee({
    orgId: actor.orgId,
    source: input.source,
    requestedAssigneeId,
  });
  const pickedByStrategy = assigneeId !== null && assigneeId !== requestedAssigneeId;
  if (actor.userId && actor.role && !permissions.canAssignNewLead(actor.role, actor.userId, assigneeId)) {
    throw new CaptureError("You can only assign a new lead to yourself. Ask a manager to assign it to someone else.");
  }

  const pipeline = await getDefaultPipeline(db, actor.orgId);
  const stage = entryStage(pipeline);

  const { data: lead, error } = await db
    .from("leads")
    .insert({
      org_id: actor.orgId,
      contact_id: contact.id,
      pipeline_id: pipeline.id,
      status_id: stage.id,
      source: input.source,
      assigned_to: assigneeId,
      created_by: actor.userId,
      priority: input.priority ?? "medium",
      value: input.value ?? null,
      external_provider: input.external?.provider ?? null,
      external_id: input.external?.id ?? null,
      created_at: input.receivedAt ?? undefined,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION && input.external) {
      // A concurrent delivery of the same event won the race on the unique index.
      const raced = await findInquiry(db, actor.orgId, input.external.provider, input.external.id);
      return finish({
        outcome: "duplicate",
        contactId: raced?.contactId ?? contact.id,
        leadId: raced?.leadId ?? null,
        createdOpportunity: raced?.createdOpportunity ?? true,
      });
    }
    if (error.code === FK_VIOLATION && assigneeId) {
      throw new CaptureError("That person isn't a member of this organization.");
    }
    if (error.code === INSUFFICIENT_PRIVILEGE) throw new CaptureError(error.message);
    throw new Error(`Failed to create lead: ${error.message}`);
  }

  const leadId = lead.id as string;
  await recordInquiry(db, actor, input, contact.id, leadId, true);

  await logActivity(db, {
    orgId: actor.orgId,
    leadId,
    actorId: actor.userId,
    type: input.timeline.type,
    title: input.timeline.title,
    description: input.timeline.description,
    metadata: input.timeline.metadata,
  });

  if (assigneeId) {
    await logActivity(db, {
      orgId: actor.orgId,
      leadId,
      actorId: actor.userId,
      type: "lead_assigned",
      title: "Assigned to salesperson",
      description: `Lead assigned to ${await displayNameOf(db, assigneeId)}${
        pickedByStrategy ? ` by ${strategy.label}` : actor.userId ? "" : " automatically"
      }.`,
      metadata: pickedByStrategy ? { strategy: strategy.name } : undefined,
    });
  }

  return finish({ outcome: "created", contactId: contact.id, leadId, assigneeId });
}

/** Adapter-facing entry: an already-normalized lead from a provider, captured as the system. */
export function inboundToCaptureInput(lead: InboundLead, extra: { assigneeId?: string | null } = {}): CaptureInput {
  return {
    firstName: lead.firstName,
    lastName: lead.lastName,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    assigneeId: extra.assigneeId ?? null,
    external: { provider: lead.provider, id: lead.externalId },
    receivedAt: lead.receivedAt,
    timeline: { type: "lead_imported_from_ads", ...lead.timeline },
  };
}

// ---------------------------------------------------------------------------

async function getDefaultCountry(db: SupabaseClient, orgId: string): Promise<CountryCode> {
  const { data } = await db.from("organizations").select("default_country").eq("id", orgId).maybeSingle();
  return ((data?.default_country as CountryCode | undefined) ?? DEFAULT_PHONE_COUNTRY) as CountryCode;
}

async function findInquiry(db: SupabaseClient, orgId: string, provider: string, externalId: string) {
  const { data, error } = await db
    .from("lead_inquiries")
    .select("contact_id, lead_id, created_opportunity")
    .eq("org_id", orgId)
    .eq("external_provider", provider)
    .eq("external_id", externalId)
    .maybeSingle();

  if (error) throw new Error(`Failed to check for a duplicate lead: ${error.message}`);
  if (!data) return null;
  return {
    contactId: data.contact_id as string,
    leadId: data.lead_id as string,
    createdOpportunity: data.created_opportunity as boolean,
  };
}

async function findOpenOpportunity(db: SupabaseClient, orgId: string, contactId: string) {
  const { data, error } = await db.rpc("find_open_opportunity_for_capture", {
    p_org: orgId,
    p_contact: contactId,
  });
  if (error) throw new Error(`Failed to look up the contact's open lead: ${error.message}`);

  const row = (data as Array<{ lead_id: string; assigned_to: string | null; created_by: string | null }> | null)?.[0];
  return row ? { leadId: row.lead_id, assignedTo: row.assigned_to, createdBy: row.created_by } : null;
}

async function recordInquiry(
  db: SupabaseClient,
  actor: CaptureActor,
  input: CaptureInput,
  contactId: string,
  leadId: string,
  createdOpportunity: boolean
): Promise<boolean> {
  const { error } = await db.from("lead_inquiries").insert({
    org_id: actor.orgId,
    contact_id: contactId,
    lead_id: leadId,
    source: input.source,
    external_provider: input.external?.provider ?? null,
    external_id: input.external?.id ?? null,
    created_opportunity: createdOpportunity,
  });
  // A replay of the same event racing us: the first writer's row stands.
  if (error && error.code === UNIQUE_VIOLATION) return false;
  if (error) throw new Error(`Failed to record the inquiry: ${error.message}`);
  return true;
}

/** Whether an opportunity was itself created by this external event (its leads row carries the id). */
async function leadWasCreatedBy(
  db: SupabaseClient,
  orgId: string,
  leadId: string,
  external: { provider: string; id: string }
): Promise<boolean> {
  const { data } = await db
    .from("leads")
    .select("external_provider, external_id")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  return data?.external_provider === external.provider && data?.external_id === external.id;
}

async function displayNameOf(db: SupabaseClient, userId: string): Promise<string> {
  const { data } = await db.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
  return data?.full_name || data?.email || "a team member";
}
