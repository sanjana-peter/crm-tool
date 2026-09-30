import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionContext } from "@/lib/auth/session";
import type { MeetingFormParsed } from "@/lib/validation/meeting";
import type { MeetingStatus } from "@/lib/types/domain";
import { normalizeEmail } from "@/lib/domain/contact";
import { DEFAULT_TIMEZONE, zonedTimeToUtc } from "@/lib/domain/due";
import { UserError } from "@/lib/domain/errors";
import { buildAttendees, calendarEventIdFor, defaultMeetingTitle, parseEmailList } from "@/lib/domain/meetings";
import type { CalendarConnection, CalendarFailure, CalendarProvider } from "@/lib/ports/calendar";
import { logActivity } from "@/lib/services/activities";
import { recordPersonalCalendarResult } from "@/lib/services/calendar-connections";
import { markConnected, markFailing } from "@/lib/services/integration-health";
import { formatDateTime } from "@/lib/format";

/** The provider + credentials the caller resolved for one meeting (see `composition/calendar.ts`). */
export interface CalendarRuntime {
  provider: CalendarProvider;
  connection: CalendarConnection;
  /** `demo` when a mock is standing in — no real event or invitation is created. */
  mode: "live" | "demo";
  /** The `calendar_connections` row behind a live runtime; null for the mock. */
  connectionId?: string | null;
  /** Set when that connection is someone's personal calendar rather than the org's shared one. */
  ownerUserId?: string | null;
}

/** Which calendar a meeting belongs on: its host's, or the one that already holds its event. */
export interface CalendarTarget {
  hostUserId?: string | null;
  connectionId?: string | null;
}

/** The calendar target of an existing meeting, so the caller can resolve the right runtime for it. */
export async function getMeetingCalendarTarget(
  db: SupabaseClient,
  session: SessionContext,
  meetingId: string
): Promise<CalendarTarget> {
  const { data, error } = await db
    .from("meetings")
    .select("salesperson_id, calendar_connection_id")
    .eq("id", meetingId)
    .eq("org_id", session.orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load meeting: ${error.message}`);
  if (!data) throw new UserError("Meeting not found.");
  return {
    hostUserId: (data.salesperson_id as string | null) ?? null,
    connectionId: (data.calendar_connection_id as string | null) ?? null,
  };
}

/**
 * Health bookkeeping for a live calendar call: the shared calendar reports
 * through integration_health; a personal one on its own connection row, so
 * one rep's expired Google grant doesn't flag the whole org's calendar as failing.
 */
async function recordCalendarHealth(
  admin: SupabaseClient,
  orgId: string,
  runtime: CalendarRuntime,
  error: string | null
): Promise<void> {
  if (runtime.ownerUserId && runtime.connectionId) {
    await recordPersonalCalendarResult(admin, orgId, runtime.connectionId, error);
  } else if (error) {
    await markFailing(admin, orgId, "google_calendar", error);
  } else {
    await markConnected(admin, orgId, "google_calendar");
  }
}

/**
 * How the calendar side of a save went. The meeting itself is always saved;
 * this says whether the calendar event exists, so the UI never implies an
 * invitation went out when it didn't.
 */
export type CalendarSync =
  | { status: "not_requested" }
  | { status: "unavailable" } // requested, but no calendar is connected
  | { status: "synced"; meetingUrl: string | null; demo: boolean }
  | { status: "failed"; error: string };

const MAX_GUESTS = 10;

async function orgTimezone(db: SupabaseClient, orgId: string): Promise<{ timezone: string; name: string }> {
  const { data } = await db.from("organizations").select("name, timezone").eq("id", orgId).maybeSingle();
  return { timezone: (data?.timezone as string | undefined) ?? DEFAULT_TIMEZONE, name: (data?.name as string | undefined) ?? "" };
}

function parseGuests(text: string | undefined): string[] {
  const guests = parseEmailList(text);
  if (guests.length > MAX_GUESTS) throw new UserError(`You can invite at most ${MAX_GUESTS} extra guests.`);
  for (const guest of guests) {
    if (!normalizeEmail(guest)) throw new UserError(`"${guest}" isn't a valid email address.`);
  }
  return guests;
}

interface MeetingContext {
  meeting: {
    id: string;
    lead_id: string;
    title: string | null;
    scheduled_start: string;
    scheduled_end: string | null;
    notes: string | null;
    meeting_url: string | null;
    provider: string;
    external_event_id: string | null;
    status: MeetingStatus;
  };
  attendees: Array<{ email: string; name: string | null }>;
}

async function loadMeeting(db: SupabaseClient, session: SessionContext, meetingId: string): Promise<MeetingContext> {
  const { data: meeting, error } = await db
    .from("meetings")
    .select("id, lead_id, title, scheduled_start, scheduled_end, notes, meeting_url, provider, external_event_id, status")
    .eq("id", meetingId)
    .eq("org_id", session.orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load meeting: ${error.message}`);
  if (!meeting) throw new UserError("Meeting not found.");

  const { data: attendees } = await db.from("meeting_attendees").select("email, name").eq("meeting_id", meetingId);
  return { meeting: meeting as MeetingContext["meeting"], attendees: (attendees ?? []) as MeetingContext["attendees"] };
}

/** Records the calendar outcome on the meeting row and reports it in the shape the UI wants. */
async function applyEventOutcome(
  db: SupabaseClient,
  admin: SupabaseClient | null,
  session: SessionContext,
  meetingId: string,
  runtime: CalendarRuntime,
  outcome:
    | { ok: true; externalEventId: string; meetingUrl: string | null; eventUrl: string | null }
    | CalendarFailure,
  existingUrl: string | null
): Promise<CalendarSync> {
  if (!outcome.ok) {
    await db.from("meetings").update({ sync_error: outcome.error }).eq("id", meetingId).eq("org_id", session.orgId);
    if (admin && runtime.mode === "live" && (outcome.code === "auth" || outcome.code === "other")) {
      await recordCalendarHealth(admin, session.orgId, runtime, outcome.error);
    }
    return { status: "failed", error: outcome.error };
  }

  await db
    .from("meetings")
    .update({
      provider: runtime.provider.id,
      calendar_connection_id: runtime.connectionId ?? null,
      external_event_id: outcome.externalEventId,
      external_event_url: outcome.eventUrl,
      meeting_url: outcome.meetingUrl ?? existingUrl,
      sync_error: null,
    })
    .eq("id", meetingId)
    .eq("org_id", session.orgId);
  if (admin && runtime.mode === "live") await recordCalendarHealth(admin, session.orgId, runtime, null);
  return { status: "synced", meetingUrl: outcome.meetingUrl ?? existingUrl, demo: runtime.mode === "demo" };
}

/**
 * Schedules a meeting. The meeting is saved first, then the calendar event is
 * created under an id derived from the meeting — so if the provider call fails
 * or times out, the salesperson still has their meeting, and retrying can never
 * create a second event. With no calendar requested/connected it works exactly
 * as the manual "log a meeting with a link" flow always did.
 */
export async function createMeeting(
  db: SupabaseClient,
  session: SessionContext,
  input: MeetingFormParsed,
  options: { calendar: CalendarRuntime | null; admin?: SupabaseClient | null } = { calendar: null }
): Promise<{ meetingId: string; calendarSync: CalendarSync }> {
  const guests = parseGuests(input.guest_emails);
  const { timezone, name: orgName } = await orgTimezone(db, session.orgId);

  const { data: lead, error: leadError } = await db
    .from("leads")
    .select("id, first_name, last_name, contact:contacts!leads_org_contact_fkey(first_name, last_name, email_normalized)")
    .eq("id", input.lead_id)
    .eq("org_id", session.orgId)
    .maybeSingle();
  if (leadError) throw new Error(`Failed to load lead: ${leadError.message}`);
  if (!lead) throw new UserError("Lead not found.");

  const salespersonId = input.salesperson_id || session.user.id;
  const { data: member } = await db
    .from("organization_members")
    .select("user_id, profile:user_id(full_name, email)")
    .eq("org_id", session.orgId)
    .eq("user_id", salespersonId)
    .maybeSingle();
  if (!member) throw new UserError("That person is not a member of this organization.");
  const salesperson = (Array.isArray(member.profile) ? member.profile[0] : member.profile) as
    | { full_name: string | null; email: string }
    | null;

  const start = zonedTimeToUtc(input.scheduled_date, input.scheduled_time, timezone);
  const end = new Date(start.getTime() + input.duration_minutes * 60_000);
  const leadName = `${lead.first_name} ${lead.last_name ?? ""}`.trim();
  const title = input.title?.trim() || defaultMeetingTitle(leadName, orgName || undefined);

  const { data: meeting, error } = await db
    .from("meetings")
    .insert({
      org_id: session.orgId,
      lead_id: input.lead_id,
      salesperson_id: salespersonId,
      title,
      scheduled_start: start.toISOString(),
      scheduled_end: end.toISOString(),
      provider: input.external_booking_url ? "calendly" : "manual",
      meeting_url: input.meeting_url || null,
      external_booking_url: input.external_booking_url || null,
      notes: input.notes || null,
      status: "scheduled",
      created_by: session.user.id,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to schedule meeting: ${error.message}`);
  const meetingId = meeting.id as string;

  const contact = (Array.isArray(lead.contact) ? lead.contact[0] : lead.contact) as
    | { first_name: string; last_name: string | null; email_normalized: string | null }
    | null;
  const attendees = buildAttendees({
    salesperson: { email: salesperson?.email ?? null, name: salesperson?.full_name ?? null },
    contact: { email: contact?.email_normalized ?? null, name: contact ? `${contact.first_name} ${contact.last_name ?? ""}`.trim() : null },
    guestEmails: guests,
  });
  if (attendees.length > 0) {
    await db
      .from("meeting_attendees")
      .insert(attendees.map((a) => ({ org_id: session.orgId, meeting_id: meetingId, email: a.email, name: a.name, role: a.role })));
  }

  let calendarSync: CalendarSync = { status: "not_requested" };
  if (input.use_calendar) {
    const runtime = options.calendar;
    if (!runtime) {
      calendarSync = { status: "unavailable" };
    } else {
      const outcome = await runtime.provider.createEvent(runtime.connection, {
        eventId: calendarEventIdFor(meetingId),
        title,
        description: input.notes || undefined,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone,
        attendees: attendees.map((a) => ({ email: a.email, name: a.name })),
        withVideoLink: !input.meeting_url,
      });
      calendarSync = await applyEventOutcome(db, options.admin ?? null, session, meetingId, runtime, outcome, input.meeting_url || null);
    }
  }

  const link = calendarSync.status === "synced" ? calendarSync.meetingUrl : input.meeting_url || null;
  await logActivity(db, {
    orgId: session.orgId,
    leadId: input.lead_id,
    actorId: session.user.id,
    type: "meeting_scheduled",
    title: "Meeting scheduled",
    description: [
      `Scheduled for ${formatDateTime(start, timezone)}.`,
      link ? `Video link: ${link}` : null,
      calendarSync.status === "synced" && calendarSync.demo ? "(Demo mode — no real calendar invitation was sent.)" : null,
      calendarSync.status === "failed" ? `Saved, but the calendar event could not be created: ${calendarSync.error}` : null,
    ]
      .filter(Boolean)
      .join(" "),
    metadata: { meeting_id: meetingId, provider: calendarSync.status === "synced" ? "calendar" : "manual" },
  });

  return { meetingId, calendarSync };
}

/** Retries creating the calendar event for a meeting that has none (a failed first attempt, or one saved before a calendar was connected). */
export async function syncMeetingToCalendar(
  db: SupabaseClient,
  session: SessionContext,
  meetingId: string,
  runtime: CalendarRuntime,
  admin: SupabaseClient | null = null
): Promise<CalendarSync> {
  const { meeting, attendees } = await loadMeeting(db, session, meetingId);
  if (meeting.external_event_id) return { status: "synced", meetingUrl: meeting.meeting_url, demo: runtime.mode === "demo" };
  if (meeting.status !== "scheduled") throw new UserError("Only a scheduled meeting can be added to the calendar.");

  const { timezone } = await orgTimezone(db, session.orgId);
  const outcome = await runtime.provider.createEvent(runtime.connection, {
    eventId: calendarEventIdFor(meetingId),
    title: meeting.title ?? "Meeting",
    description: meeting.notes ?? undefined,
    startsAt: meeting.scheduled_start,
    endsAt: meeting.scheduled_end ?? new Date(new Date(meeting.scheduled_start).getTime() + 30 * 60_000).toISOString(),
    timezone,
    attendees,
    withVideoLink: !meeting.meeting_url,
  });
  return applyEventOutcome(db, admin, session, meetingId, runtime, outcome, meeting.meeting_url);
}

/** Moves a meeting, and its calendar event if it has one. */
export async function rescheduleMeeting(
  db: SupabaseClient,
  session: SessionContext,
  meetingId: string,
  when: { date: string; time: string; durationMinutes: number },
  options: { calendar: CalendarRuntime | null; admin?: SupabaseClient | null } = { calendar: null }
): Promise<{ leadId: string; calendarSync: CalendarSync }> {
  const { meeting } = await loadMeeting(db, session, meetingId);
  if (meeting.status !== "scheduled") throw new UserError("Only a scheduled meeting can be rescheduled.");

  const { timezone } = await orgTimezone(db, session.orgId);
  const start = zonedTimeToUtc(when.date, when.time, timezone);
  const end = new Date(start.getTime() + when.durationMinutes * 60_000);

  const { error } = await db
    .from("meetings")
    .update({ scheduled_start: start.toISOString(), scheduled_end: end.toISOString() })
    .eq("id", meetingId)
    .eq("org_id", session.orgId);
  if (error) throw new Error(`Failed to reschedule meeting: ${error.message}`);

  let calendarSync: CalendarSync = { status: "not_requested" };
  if (meeting.external_event_id && options.calendar && options.calendar.provider.id === meeting.provider) {
    const outcome = await options.calendar.provider.updateEventTime(options.calendar.connection, meeting.external_event_id, {
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      timezone,
    });
    if (outcome.ok) {
      await db.from("meetings").update({ sync_error: null }).eq("id", meetingId).eq("org_id", session.orgId);
      calendarSync = { status: "synced", meetingUrl: meeting.meeting_url, demo: options.calendar.mode === "demo" };
    } else {
      await db.from("meetings").update({ sync_error: outcome.error }).eq("id", meetingId).eq("org_id", session.orgId);
      calendarSync = { status: "failed", error: outcome.error };
    }
  }

  await logActivity(db, {
    orgId: session.orgId,
    leadId: meeting.lead_id,
    actorId: session.user.id,
    type: "meeting_rescheduled",
    title: "Meeting rescheduled",
    description: `Moved to ${formatDateTime(start, timezone)}.${calendarSync.status === "failed" ? ` The calendar event could not be updated: ${calendarSync.error}` : ""}`,
    metadata: { meeting_id: meetingId },
  });

  return { leadId: meeting.lead_id, calendarSync };
}

const STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

const STATUS_ACTIVITY: Record<MeetingStatus, "meeting_completed" | "meeting_cancelled" | null> = {
  scheduled: null,
  completed: "meeting_completed",
  cancelled: "meeting_cancelled",
  no_show: "meeting_cancelled",
};

/**
 * Updates a meeting's status. The lead the timeline entry belongs to comes from
 * the meeting row, never from the caller. Cancelling also cancels the calendar
 * event; if that fails the meeting is still cancelled (it *was*) and the error
 * is kept on the row rather than blocking the salesperson.
 */
export async function updateMeetingStatus(
  db: SupabaseClient,
  session: SessionContext,
  meetingId: string,
  status: MeetingStatus,
  options: { calendar: CalendarRuntime | null } = { calendar: null }
) {
  const { meeting } = await loadMeeting(db, session, meetingId);

  const update: Record<string, unknown> = { status };
  if (status === "cancelled" && meeting.external_event_id && options.calendar && options.calendar.provider.id === meeting.provider) {
    const outcome = await options.calendar.provider.cancelEvent(options.calendar.connection, meeting.external_event_id);
    update.sync_error = outcome.ok ? null : `Cancelled here, but the calendar event could not be removed: ${outcome.error}`;
  }

  const { error } = await db.from("meetings").update(update).eq("id", meetingId).eq("org_id", session.orgId);
  if (error) throw new Error(`Failed to update meeting: ${error.message}`);

  const activityType = STATUS_ACTIVITY[status];
  if (activityType) {
    await logActivity(db, {
      orgId: session.orgId,
      leadId: meeting.lead_id,
      actorId: session.user.id,
      type: activityType,
      title: `Meeting ${STATUS_LABELS[status].toLowerCase()}`,
    });
  }

  return { leadId: meeting.lead_id };
}
