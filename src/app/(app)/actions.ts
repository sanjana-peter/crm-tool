"use server";

import { createClient } from "@/lib/supabase/server";
import { requireSession, type SessionContext } from "@/lib/auth/session";
import { canAccessLead } from "@/lib/domain/permissions";
import { UserError } from "@/lib/domain/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { leadPaths, runAction, type ActionResult } from "@/lib/actions/run";
import { resolveCalendar } from "@/lib/composition/calendar";
import { resolveWhatsApp } from "@/lib/composition/whatsapp";
import { resolveInstagram } from "@/lib/composition/instagram";
import { buildMockInstagramDm } from "@/lib/integrations/instagram/mock-adapter";
import { mockProvidersEnabled } from "@/lib/integrations/mode";
import type { ConsentStatus } from "@/lib/domain/whatsapp";
import * as conversationsService from "@/lib/services/conversations";
import * as instagramConversations from "@/lib/services/instagram-conversations";
import {
  leadFormFieldsSchema,
  leadFormSchema,
  leadStatusChangeSchema,
  leadAssignSchema,
  type LeadFormInput,
} from "@/lib/validation/lead";
import { noteFormSchema, type NoteFormInput } from "@/lib/validation/note";
import {
  meetingFormSchema,
  meetingRescheduleSchema,
  meetingStatusSchema,
  type MeetingFormInput,
} from "@/lib/validation/meeting";
import { followupFormSchema, followupStatusSchema, type FollowupFormInput } from "@/lib/validation/followup";
import { callLogSchema, type CallLogInput } from "@/lib/validation/call";
import * as leadsService from "@/lib/services/leads";
import * as notesService from "@/lib/services/notes";
import * as meetingsService from "@/lib/services/meetings";
import * as followupsService from "@/lib/services/followups";
import * as callsService from "@/lib/services/calls";

export type { ActionResult };

function firstIssue(error: { issues: Array<{ message: string }> }, fallback: string) {
  return error.issues[0]?.message ?? fallback;
}

/**
 * What a create-lead call turned into. `merged` means the person already had
 * an open lead, so nothing new was created — the UI should say so and open it.
 */
export type CreateLeadOutcome = { id: string; outcome: "created" | "merged" };

export async function createLeadAction(input: LeadFormInput): Promise<ActionResult<CreateLeadOutcome>> {
  const parsed = leadFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid input") };

  const session = await requireSession();
  const db = await createClient();

  return runAction<CreateLeadOutcome>(
    "createLead",
    async () => {
      const result = await leadsService.createLead(db, session, parsed.data);
      switch (result.outcome) {
        case "created":
        case "merged":
          return { id: result.leadId, outcome: result.outcome };
        case "duplicate":
          throw new UserError("That lead was already added.");
        case "existing_restricted":
          throw new UserError(
            "This person is already an active lead assigned to a colleague. Ask a manager if it should move to you."
          );
      }
    },
    leadPaths()
  );
}

export async function updateLeadAction(leadId: string, input: LeadFormInput): Promise<ActionResult> {
  // The "phone or email" rule is checked by the service, which knows whether
  // the contact is reachable on Instagram instead.
  const parsed = leadFormFieldsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid input") };

  const session = await requireSession();
  const db = await createClient();
  return runAction("updateLead", () => leadsService.updateLead(db, session, leadId, parsed.data), leadPaths(leadId));
}

export async function assignLeadAction(leadId: string, assignedTo: string): Promise<ActionResult> {
  const parsed = leadAssignSchema.safeParse({ lead_id: leadId, assigned_to: assignedTo });
  if (!parsed.success) return { ok: false, error: "Invalid assignment." };

  const session = await requireSession();
  const db = await createClient();
  return runAction("assignLead", () => leadsService.assignLead(db, session, leadId, assignedTo), leadPaths(leadId));
}

/** `lostReason` is required when the target stage is a lost stage. */
export async function changeLeadStatusAction(
  leadId: string,
  statusId: string,
  lostReason?: string
): Promise<ActionResult> {
  const parsed = leadStatusChangeSchema.safeParse({ lead_id: leadId, status_id: statusId, lost_reason: lostReason });
  if (!parsed.success) return { ok: false, error: "Invalid status." };

  const session = await requireSession();
  const db = await createClient();
  return runAction(
    "changeLeadStage",
    () => leadsService.changeLeadStage(db, session, leadId, statusId, parsed.data.lost_reason || null),
    leadPaths(leadId)
  );
}

export async function createNoteAction(input: NoteFormInput): Promise<ActionResult> {
  const parsed = noteFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid note.") };

  const session = await requireSession();
  const db = await createClient();
  return runAction(
    "createNote",
    async () => {
      await notesService.createNote(db, session, parsed.data);
    },
    leadPaths(parsed.data.lead_id)
  );
}

export async function logCallAction(input: CallLogInput): Promise<ActionResult<{ callId: string }>> {
  const parsed = callLogSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid call.") };

  const session = await requireSession();
  const db = await createClient();
  return runAction("logCall", () => callsService.logCall(db, session, parsed.data), leadPaths(parsed.data.lead_id));
}

/** What the calendar side of a meeting save did — so the UI can say exactly what happened. */
export type MeetingSaveData = { calendar: meetingsService.CalendarSync };

/** Resolved only when needed: a plain "log a meeting with a link" never touches calendar credentials. */
async function calendarFor(orgId: string, needed: boolean, target: meetingsService.CalendarTarget) {
  return needed ? resolveCalendar(createAdminClient(), orgId, target) : null;
}

/** An existing meeting's calendar: the one holding its event, else its host's. */
async function calendarForMeeting(
  db: Awaited<ReturnType<typeof createClient>>,
  session: SessionContext,
  meetingId: string,
  needed: boolean
) {
  if (!needed) return null;
  return calendarFor(session.orgId, true, await meetingsService.getMeetingCalendarTarget(db, session, meetingId));
}

export async function createMeetingAction(input: MeetingFormInput): Promise<ActionResult<MeetingSaveData>> {
  const parsed = meetingFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid meeting.") };

  const session = await requireSession();
  const db = await createClient();
  return runAction<MeetingSaveData>(
    "createMeeting",
    async () => {
      const calendar = await calendarFor(session.orgId, parsed.data.use_calendar, {
        hostUserId: parsed.data.salesperson_id || session.user.id,
      });
      const result = await meetingsService.createMeeting(db, session, parsed.data, { calendar, admin: createAdminClient() });
      return { calendar: result.calendarSync };
    },
    leadPaths(parsed.data.lead_id)
  );
}

export async function rescheduleMeetingAction(
  meetingId: string,
  when: { scheduled_date: string; scheduled_time: string; duration_minutes: number }
): Promise<ActionResult<MeetingSaveData>> {
  const parsed = meetingRescheduleSchema.safeParse({ meeting_id: meetingId, ...when });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid time.") };

  const session = await requireSession();
  const db = await createClient();
  return runAction<MeetingSaveData>(
    "rescheduleMeeting",
    async () => {
      const calendar = await calendarForMeeting(db, session, meetingId, true);
      const result = await meetingsService.rescheduleMeeting(
        db,
        session,
        meetingId,
        { date: parsed.data.scheduled_date, time: parsed.data.scheduled_time, durationMinutes: parsed.data.duration_minutes },
        { calendar, admin: createAdminClient() }
      );
      return { calendar: result.calendarSync };
    },
    leadPaths()
  );
}

/** Retry creating the calendar event for a meeting that doesn't have one. */
export async function syncMeetingCalendarAction(meetingId: string): Promise<ActionResult<MeetingSaveData>> {
  if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return { ok: false, error: "Invalid meeting." };
  const session = await requireSession();
  const db = await createClient();
  return runAction<MeetingSaveData>(
    "syncMeetingCalendar",
    async () => {
      const calendar = await calendarForMeeting(db, session, meetingId, true);
      if (!calendar) {
        throw new UserError(
          "No calendar is connected. Connect your own Google Calendar in Settings, or ask an admin to connect a shared one."
        );
      }
      return { calendar: await meetingsService.syncMeetingToCalendar(db, session, meetingId, calendar, createAdminClient()) };
    },
    leadPaths()
  );
}

export async function updateMeetingStatusAction(meetingId: string, status: string): Promise<ActionResult> {
  const parsed = meetingStatusSchema.safeParse({ meeting_id: meetingId, status });
  if (!parsed.success) return { ok: false, error: "Invalid meeting status." };

  const session = await requireSession();
  const db = await createClient();
  return runAction(
    "updateMeetingStatus",
    async () => {
      const calendar = await calendarForMeeting(db, session, meetingId, parsed.data.status === "cancelled");
      await meetingsService.updateMeetingStatus(db, session, meetingId, parsed.data.status, { calendar });
    },
    leadPaths()
  );
}

export async function createFollowupAction(input: FollowupFormInput): Promise<ActionResult> {
  const parsed = followupFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error, "Invalid follow-up.") };

  const session = await requireSession();
  const db = await createClient();
  return runAction(
    "createFollowup",
    async () => {
      await followupsService.createFollowup(db, session, parsed.data);
    },
    leadPaths(parsed.data.lead_id)
  );
}

export async function updateFollowupStatusAction(followupId: string, status: string): Promise<ActionResult> {
  const parsed = followupStatusSchema.safeParse({ followup_id: followupId, status });
  if (!parsed.success) return { ok: false, error: "Invalid follow-up status." };

  const session = await requireSession();
  const db = await createClient();
  return runAction(
    "updateFollowupStatus",
    async () => {
      await followupsService.updateFollowupStatus(db, session, followupId, parsed.data.status);
    },
    leadPaths()
  );
}

export type WhatsAppSendData = { status: "sent" } | { status: "failed"; error: string };

/** The acting user must be able to see the lead — the same rule as everywhere else. */
async function requireLeadAccess(leadId: string) {
  const session = await requireSession();
  const db = await createClient();
  const { data: lead } = await db.from("leads").select("assigned_to, created_by").eq("id", leadId).maybeSingle();
  if (!lead || !canAccessLead(session.role, session.user.id, lead)) throw new UserError("Lead not found.");
  return session;
}

async function requireWhatsApp(orgId: string) {
  const runtime = await resolveWhatsApp(createAdminClient(), orgId);
  if (!runtime) throw new UserError("WhatsApp isn't connected. An admin can connect it in Settings → Integrations.");
  return runtime;
}

function toSendData(result: conversationsService.SendResult): WhatsAppSendData {
  return result.status === "sent" ? { status: "sent" } : { status: "failed", error: result.error };
}

export async function sendWhatsAppTemplateAction(
  leadId: string,
  templateId: string,
  variableValues: string[]
): Promise<ActionResult<WhatsAppSendData>> {
  const session = await requireSession();
  return runAction<WhatsAppSendData>(
    "sendWhatsAppTemplate",
    async () => {
      await requireLeadAccess(leadId);
      const runtime = await requireWhatsApp(session.orgId);
      const result = await conversationsService.sendTemplateMessage(createAdminClient(), runtime, {
        orgId: session.orgId,
        leadId,
        templateId,
        variableValues,
        sentByUserId: session.user.id,
      });
      return toSendData(result);
    },
    leadPaths(leadId)
  );
}

export async function sendWhatsAppTextAction(leadId: string, body: string): Promise<ActionResult<WhatsAppSendData>> {
  const session = await requireSession();
  return runAction<WhatsAppSendData>(
    "sendWhatsAppText",
    async () => {
      await requireLeadAccess(leadId);
      const runtime = await requireWhatsApp(session.orgId);
      const result = await conversationsService.sendTextMessage(createAdminClient(), runtime, {
        orgId: session.orgId,
        leadId,
        body,
        sentByUserId: session.user.id,
      });
      return toSendData(result);
    },
    leadPaths(leadId)
  );
}

export async function setWhatsAppConsentAction(
  leadId: string,
  status: ConsentStatus,
  source: string
): Promise<ActionResult> {
  if (!["unknown", "opted_in", "opted_out"].includes(status)) return { ok: false, error: "Invalid consent." };
  const session = await requireSession();
  const db = await createClient();
  return runAction(
    "setWhatsAppConsent",
    async () => {
      await requireLeadAccess(leadId);
      const { data: lead } = await db.from("leads").select("contact_id").eq("id", leadId).eq("org_id", session.orgId).maybeSingle();
      if (!lead) throw new UserError("Lead not found.");
      await conversationsService.setWhatsAppConsent(db, {
        contactId: lead.contact_id as string,
        status,
        source: source.trim() || "recorded by team member",
      });
    },
    leadPaths(leadId)
  );
}

/**
 * Demo mode only: pretend the customer replied, through the very same inbound
 * path a real webhook takes. Lets a design partner see the two-way flow
 * without a WhatsApp Business account. Unavailable once a real number is live.
 */
export async function simulateWhatsAppReplyAction(leadId: string, text: string): Promise<ActionResult> {
  const session = await requireSession();
  const admin = createAdminClient();
  return runAction(
    "simulateWhatsAppReply",
    async () => {
      if (!mockProvidersEnabled()) throw new UserError("Simulated replies are only available in demo mode.");
      await requireLeadAccess(leadId);
      const runtime = await resolveWhatsApp(admin, session.orgId);
      if (!runtime || runtime.mode !== "demo") {
        throw new UserError("Simulated replies are only available in demo mode.");
      }

      const { data: lead } = await admin
        .from("leads")
        .select("contact:contacts!leads_org_contact_fkey(phone_normalized, first_name)")
        .eq("id", leadId)
        .eq("org_id", session.orgId)
        .maybeSingle();
      const contact = (Array.isArray(lead?.contact) ? lead?.contact[0] : lead?.contact) as
        | { phone_normalized: string | null; first_name: string }
        | null;
      if (!contact?.phone_normalized) throw new UserError("This lead has no phone number.");

      const from = contact.phone_normalized.replace(/^\+/, "");
      const payload = JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: runtime.connection.phoneNumberId },
                  contacts: [{ wa_id: from, profile: { name: contact.first_name } }],
                  messages: [
                    {
                      from,
                      id: `mock.in.${crypto.randomUUID()}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "text",
                      text: { body: text.trim().slice(0, 1000) || "Hi" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      await conversationsService.handleWhatsAppEvents(admin, {
        provider: runtime.provider,
        events: runtime.provider.parseWebhook(payload),
        requestId: crypto.randomUUID(),
      });
    },
    leadPaths(leadId)
  );
}

export async function sendInstagramReplyAction(leadId: string, body: string): Promise<ActionResult<WhatsAppSendData>> {
  const session = await requireSession();
  return runAction<WhatsAppSendData>(
    "sendInstagramReply",
    async () => {
      await requireLeadAccess(leadId);
      const runtime = await resolveInstagram(createAdminClient(), session.orgId);
      if (!runtime) throw new UserError("Instagram isn't connected. An admin can connect it in Settings → Integrations.");
      const result = await instagramConversations.sendInstagramText(createAdminClient(), runtime, {
        orgId: session.orgId,
        leadId,
        body,
        sentByUserId: session.user.id,
      });
      return result.status === "sent" ? { status: "sent" } : { status: "failed", error: result.error };
    },
    leadPaths(leadId)
  );
}

/** Demo mode only: the lead DMs the org's Instagram account again, through the real inbound path. */
export async function simulateInstagramReplyAction(leadId: string, text: string): Promise<ActionResult> {
  const session = await requireSession();
  const admin = createAdminClient();
  return runAction(
    "simulateInstagramReply",
    async () => {
      if (!mockProvidersEnabled()) throw new UserError("Simulated replies are only available in demo mode.");
      await requireLeadAccess(leadId);
      const runtime = await resolveInstagram(admin, session.orgId);
      if (!runtime || runtime.mode !== "demo") throw new UserError("Simulated replies are only available in demo mode.");

      const { data: lead } = await admin
        .from("leads")
        .select("contact:contacts!leads_org_contact_fkey(instagram_user_id)")
        .eq("id", leadId)
        .eq("org_id", session.orgId)
        .maybeSingle();
      const contact = (Array.isArray(lead?.contact) ? lead?.contact[0] : lead?.contact) as { instagram_user_id: string | null } | null;
      if (!contact?.instagram_user_id) throw new UserError("This lead has never messaged you on Instagram.");

      const payload = buildMockInstagramDm({
        accountId: runtime.connection.accountId,
        senderId: contact.instagram_user_id,
        text: text.trim().slice(0, 1000) || "Hi",
      });
      await instagramConversations.handleInstagramEvents(admin, {
        provider: runtime.provider,
        events: runtime.provider.parseWebhook(payload),
        requestId: crypto.randomUUID(),
      });
    },
    leadPaths(leadId)
  );
}

export async function deleteLeadAction(leadId: string): Promise<ActionResult> {
  const session = await requireSession();
  const db = await createClient();
  return runAction("deleteLead", () => leadsService.deleteLead(db, session, leadId), leadPaths());
}
