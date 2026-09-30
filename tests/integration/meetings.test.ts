import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveCalendar } from "@/lib/composition/calendar";
import { calendarEventIdFor } from "@/lib/domain/meetings";
import { MockCalendarProvider } from "@/lib/integrations/google/mock-adapter";
import type { CalendarConnection, CalendarEventInput, CalendarProvider } from "@/lib/ports/calendar";
import { captureLead } from "@/lib/services/capture";
import {
  disconnectCalendar,
  getCalendarConnection,
  getCalendarCredential,
  getPersonalCalendarConnection,
  saveCalendarConnection,
} from "@/lib/services/calendar-connections";
import {
  createMeeting,
  getMeetingCalendarTarget,
  rescheduleMeeting,
  syncMeetingToCalendar,
  updateMeetingStatus,
  type CalendarRuntime,
} from "@/lib/services/meetings";
import {
  SEED_USERS,
  SYSTEM,
  admin,
  anonClient,
  createRivalOrg,
  manualInput,
  seedOrgId,
  sessionFor,
  uniqueEmail,
  userIdOf,
} from "./support";

/** A mock provider that also records what the service asked of it. */
class SpyCalendar implements CalendarProvider {
  readonly id = "mock";
  readonly isMock = true;
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  private readonly inner = new MockCalendarProvider();

  async createEvent(c: CalendarConnection, e: CalendarEventInput) {
    this.calls.push({ op: "create", args: [e] });
    return this.inner.createEvent(c, e);
  }
  async updateEventTime(c: CalendarConnection, id: string, change: { startsAt: string; endsAt: string; timezone: string }) {
    this.calls.push({ op: "update", args: [id, change] });
    return this.inner.updateEventTime();
  }
  async cancelEvent(c: CalendarConnection, id: string) {
    this.calls.push({ op: "cancel", args: [id] });
    return this.inner.cancelEvent();
  }
}

let orgId: string;
let manager: Awaited<ReturnType<typeof sessionFor>>;
let jordan: Awaited<ReturnType<typeof sessionFor>>;
let adminUser: Awaited<ReturnType<typeof sessionFor>>;
let rival: Awaited<ReturnType<typeof createRivalOrg>>;
let spy: SpyCalendar;
let runtime: CalendarRuntime;

beforeAll(async () => {
  orgId = await seedOrgId();
  manager = await sessionFor(SEED_USERS.manager);
  jordan = await sessionFor(SEED_USERS.jordan);
  adminUser = await sessionFor(SEED_USERS.admin);
  rival = await createRivalOrg();
});

afterAll(async () => {
  await rival?.cleanup();
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

async function newLead(overrides = {}) {
  const jordanId = await userIdOf(SEED_USERS.jordan);
  const result = await captureLead(
    admin,
    SYSTEM(orgId),
    manualInput({ firstName: "Riya", lastName: "Kapoor", email: uniqueEmail("riya"), assigneeId: jordanId, ...overrides })
  );
  if (result.outcome !== "created") throw new Error("setup failed");
  return result;
}

function freshRuntime(): CalendarRuntime {
  spy = new SpyCalendar();
  runtime = { provider: spy, connection: { calendarId: "primary", credential: "mock" }, mode: "demo" };
  return runtime;
}

const input = (leadId: string, extra: Record<string, unknown> = {}) => ({
  lead_id: leadId,
  scheduled_date: "2030-03-15",
  scheduled_time: "15:00",
  duration_minutes: 30,
  use_calendar: true,
  ...extra,
});

async function meetingRow(id: string) {
  const { data } = await admin.from("meetings").select("*").eq("id", id).single();
  return data!;
}

describe("scheduling a meeting with a calendar (quality gate 6)", () => {
  it("creates the meeting, the calendar event with a Meet link, the attendees and a timeline entry", async () => {
    const lead = await newLead();
    const { meetingId, calendarSync } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: freshRuntime() });

    expect(calendarSync.status).toBe("synced");
    const meeting = await meetingRow(meetingId);
    expect(meeting).toMatchObject({ provider: "mock", status: "scheduled", sync_error: null, lead_id: lead.leadId });
    expect(meeting.external_event_id).toBe(`mock.event.${calendarEventIdFor(meetingId)}`);
    expect(meeting.meeting_url).toContain("meet.google.com/demo-");
    expect(meeting.title).toMatch(/Riya Kapoor/);

    const { data: attendees } = await admin.from("meeting_attendees").select("email, role").eq("meeting_id", meetingId);
    expect(attendees?.map((a) => a.role).sort()).toEqual(["contact", "salesperson"]);
    expect(attendees?.find((a) => a.role === "salesperson")?.email).toBe(SEED_USERS.jordan);

    const { data: activities } = await admin.from("activities").select("activity_type, description").eq("lead_id", lead.leadId);
    const scheduled = activities?.find((a) => a.activity_type === "meeting_scheduled");
    expect(scheduled?.description).toMatch(/demo mode/i);
    expect(scheduled?.description).toContain(meeting.meeting_url);
  });

  it("stores the time in the organization's zone: 15:00 IST is 09:30 UTC (regression: it used the server's zone)", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId, { scheduled_date: "2030-03-15", scheduled_time: "15:00", duration_minutes: 45 }) as never, { calendar: freshRuntime() });

    const meeting = await meetingRow(meetingId);
    expect(new Date(meeting.scheduled_start as string).toISOString()).toBe("2030-03-15T09:30:00.000Z");
    expect(new Date(meeting.scheduled_end as string).toISOString()).toBe("2030-03-15T10:15:00.000Z");

    const event = spy.calls[0].args[0] as CalendarEventInput;
    expect(event).toMatchObject({ startsAt: "2030-03-15T09:30:00.000Z", timezone: "Asia/Kolkata" });
  });

  it("uses the timezone of whichever org the meeting belongs to", async () => {
    await admin.from("organizations").update({ timezone: "America/New_York" }).eq("id", rival.orgId);
    const rivalSession = await sessionFor(rival.adminEmail);
    const theirs = await captureLead(admin, SYSTEM(rival.orgId), manualInput({ email: uniqueEmail("x") }));
    if (theirs.outcome !== "created") throw new Error("setup failed");

    const { meetingId } = await createMeeting(rivalSession.db, rivalSession.session, input(theirs.leadId, { scheduled_date: "2030-07-01", scheduled_time: "09:00", use_calendar: false }) as never);
    expect(new Date((await meetingRow(meetingId)).scheduled_start as string).toISOString()).toBe("2030-07-01T13:00:00.000Z");
  });

  it("invites extra guests and never the same address twice", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(
      jordan.db,
      jordan.session,
      input(lead.leadId, { guest_emails: "boss@firm.com; boss@firm.com, " + SEED_USERS.jordan }) as never,
      { calendar: freshRuntime() }
    );
    const { data } = await admin.from("meeting_attendees").select("email, role").eq("meeting_id", meetingId);
    expect(data?.map((a) => a.email).sort()).toEqual(["boss@firm.com", SEED_USERS.jordan, (await admin.from("contacts").select("email_normalized").eq("id", lead.contactId).single()).data!.email_normalized].sort());
    expect(data?.filter((a) => a.email === SEED_USERS.jordan)).toHaveLength(1);
    expect(data?.find((a) => a.email === SEED_USERS.jordan)?.role).toBe("salesperson");
  });

  it("logs a manual meeting with a pasted link without touching any calendar", async () => {
    const lead = await newLead();
    const { meetingId, calendarSync } = await createMeeting(
      jordan.db,
      jordan.session,
      input(lead.leadId, { use_calendar: false, meeting_url: "https://meet.google.com/abc-defg-hij" }) as never,
      { calendar: freshRuntime() }
    );
    expect(calendarSync.status).toBe("not_requested");
    expect(spy.calls).toHaveLength(0);
    expect(await meetingRow(meetingId)).toMatchObject({ provider: "manual", meeting_url: "https://meet.google.com/abc-defg-hij", external_event_id: null });
  });

  it("saves the meeting and says so when a calendar was requested but none is connected", async () => {
    const lead = await newLead();
    const { meetingId, calendarSync } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: null });
    expect(calendarSync.status).toBe("unavailable");
    expect((await meetingRow(meetingId)).provider).toBe("manual");
  });

  it("rejects bad guest emails, too many guests, and a salesperson from another org", async () => {
    const lead = await newLead();
    await expect(createMeeting(jordan.db, jordan.session, input(lead.leadId, { guest_emails: "not-an-email" }) as never)).rejects.toThrow(/valid email/i);
    const many = Array.from({ length: 11 }, (_, i) => `g${i}@x.com`).join(",");
    await expect(createMeeting(jordan.db, jordan.session, input(lead.leadId, { guest_emails: many }) as never)).rejects.toThrow(/at most 10/i);
    await expect(createMeeting(manager.db, manager.session, input(lead.leadId, { salesperson_id: rival.adminId }) as never)).rejects.toThrow(/not a member/i);
  });

  it("cannot schedule against a lead the caller cannot see", async () => {
    const priyaLead = await newLead({ assigneeId: await userIdOf(SEED_USERS.priya) });
    await expect(createMeeting(jordan.db, jordan.session, input(priyaLead.leadId, { use_calendar: false }) as never)).rejects.toThrow(/lead not found/i);
  });
});

describe("when the calendar fails", () => {
  it("still saves the meeting, records the error visibly, and does not claim success", async () => {
    const lead = await newLead();
    const { meetingId, calendarSync } = await createMeeting(
      jordan.db,
      jordan.session,
      input(lead.leadId, { guest_emails: "someone@fail.test" }) as never,
      { calendar: freshRuntime() }
    );

    expect(calendarSync).toMatchObject({ status: "failed" });
    const meeting = await meetingRow(meetingId);
    expect(meeting.provider).toBe("manual");
    expect(meeting.external_event_id).toBeNull();
    expect(meeting.sync_error).toMatch(/unavailable/i);

    const { data: activities } = await admin.from("activities").select("description").eq("lead_id", lead.leadId).eq("activity_type", "meeting_scheduled");
    expect(activities?.[0].description).toMatch(/could not be created/i);
  });

  it("retries into the same event id, and a retry of a synced meeting is a no-op", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId, { guest_emails: "someone@fail.test" }) as never, { calendar: freshRuntime() });
    expect((await meetingRow(meetingId)).sync_error).not.toBeNull();

    // The failure was the guest's address; remove it and retry.
    await admin.from("meeting_attendees").delete().eq("meeting_id", meetingId).eq("email", "someone@fail.test");
    const retried = await syncMeetingToCalendar(jordan.db, jordan.session, meetingId, runtime);
    expect(retried.status).toBe("synced");

    const meeting = await meetingRow(meetingId);
    expect(meeting).toMatchObject({ provider: "mock", sync_error: null });
    expect(meeting.external_event_id).toBe(`mock.event.${calendarEventIdFor(meetingId)}`);

    const createCalls = spy.calls.filter((c) => c.op === "create");
    expect(new Set(createCalls.map((c) => (c.args[0] as CalendarEventInput).eventId)).size).toBe(1); // same id every attempt

    const again = await syncMeetingToCalendar(jordan.db, jordan.session, meetingId, runtime);
    expect(again.status).toBe("synced");
    expect(spy.calls.filter((c) => c.op === "create")).toHaveLength(createCalls.length); // no extra provider call
  });
});

describe("rescheduling and cancelling", () => {
  it("moves the meeting and its calendar event, and records it on the timeline", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: freshRuntime() });

    const result = await rescheduleMeeting(jordan.db, jordan.session, meetingId, { date: "2030-03-20", time: "11:30", durationMinutes: 60 }, { calendar: runtime });
    expect(result.calendarSync.status).toBe("synced");

    const meeting = await meetingRow(meetingId);
    expect(new Date(meeting.scheduled_start as string).toISOString()).toBe("2030-03-20T06:00:00.000Z"); // 11:30 IST
    expect(new Date(meeting.scheduled_end as string).toISOString()).toBe("2030-03-20T07:00:00.000Z");

    const update = spy.calls.find((c) => c.op === "update")!;
    expect(update.args[0]).toBe(meeting.external_event_id);
    expect(update.args[1]).toMatchObject({ startsAt: "2030-03-20T06:00:00.000Z", timezone: "Asia/Kolkata" });

    const { data: activities } = await admin.from("activities").select("activity_type").eq("lead_id", lead.leadId);
    expect(activities?.some((a) => a.activity_type === "meeting_rescheduled")).toBe(true);
  });

  it("cancels the calendar event when the meeting is cancelled", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: freshRuntime() });
    const externalId = (await meetingRow(meetingId)).external_event_id;

    await updateMeetingStatus(jordan.db, jordan.session, meetingId, "cancelled", { calendar: runtime });
    expect((await meetingRow(meetingId)).status).toBe("cancelled");
    expect(spy.calls.find((c) => c.op === "cancel")?.args[0]).toBe(externalId);

    const { data: activities } = await admin.from("activities").select("activity_type").eq("lead_id", lead.leadId);
    expect(activities?.some((a) => a.activity_type === "meeting_cancelled")).toBe(true);
  });

  it("records completion on the timeline without calling the calendar", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: freshRuntime() });
    spy.calls.length = 0;

    await updateMeetingStatus(jordan.db, jordan.session, meetingId, "completed", { calendar: runtime });
    expect(spy.calls).toHaveLength(0);
    const { data: activities } = await admin.from("activities").select("activity_type").eq("lead_id", lead.leadId);
    expect(activities?.some((a) => a.activity_type === "meeting_completed")).toBe(true);
  });

  it("only reschedules a scheduled meeting", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId, { use_calendar: false }) as never);
    await updateMeetingStatus(jordan.db, jordan.session, meetingId, "completed");
    await expect(rescheduleMeeting(jordan.db, jordan.session, meetingId, { date: "2030-04-01", time: "10:00", durationMinutes: 30 })).rejects.toThrow(/only a scheduled meeting/i);
  });

  it("writes the timeline entry against the meeting's own lead, never a caller-supplied one", async () => {
    const lead = await newLead();
    const other = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId, { use_calendar: false }) as never);
    await updateMeetingStatus(jordan.db, jordan.session, meetingId, "completed");

    const { data: mine } = await admin.from("activities").select("activity_type").eq("lead_id", lead.leadId);
    const { data: unrelated } = await admin.from("activities").select("activity_type").eq("lead_id", other.leadId);
    expect(mine?.some((a) => a.activity_type === "meeting_completed")).toBe(true);
    expect(unrelated?.some((a) => a.activity_type === "meeting_completed")).toBe(false);
  });
});

describe("Google connection storage", () => {
  it("encrypts the refresh token at rest, decrypts it for use, and audits connect and disconnect", async () => {
    const token = "1//0gSuperSecretRefreshToken";
    const { connectionId } = await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "sales@summit.example", refreshToken: token, scopes: ["https://www.googleapis.com/auth/calendar.events"] });

    const { data: stored } = await admin.from("calendar_tokens").select("refresh_token").eq("connection_id", connectionId).single();
    expect(stored?.refresh_token).not.toContain(token);
    expect(String(stored?.refresh_token)).toMatch(/^enc:v1:/);
    expect(await getCalendarCredential(admin, connectionId)).toBe(token);

    const connection = await getCalendarConnection(admin, orgId);
    expect(connection).toMatchObject({ provider: "google", account_email: "sales@summit.example" });

    const { data: health } = await admin.from("integration_health").select("status").eq("org_id", orgId).eq("provider", "google_calendar").single();
    expect(health?.status).toBe("connected");

    await disconnectCalendar(admin, orgId, adminUser.session.user.id);
    expect(await getCalendarConnection(admin, orgId)).toBeNull();
    expect(await getCalendarCredential(admin, connectionId)).toBeNull();

    const { data: audit } = await admin.from("audit_events").select("action, summary").eq("org_id", orgId).eq("entity_id", "google_calendar");
    expect(audit?.map((a) => a.action)).toEqual(expect.arrayContaining(["integration.connected", "integration.disconnected"]));
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("picks the live Google adapter only when connected AND the server is configured, else demo, else none", async () => {
    // Nothing connected: demo (mock providers are on outside production).
    expect((await resolveCalendar(admin, orgId))?.mode).toBe("demo");

    await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "sales@summit.example", refreshToken: "1//rt", scopes: [] });
    // Connected, but this server has no Google credentials: falls back to demo rather than pretending.
    expect((await resolveCalendar(admin, orgId))?.mode).toBe("demo");

    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    const live = await resolveCalendar(admin, orgId);
    expect(live?.mode).toBe("live");
    expect(live?.provider.id).toBe("google");
    expect(live?.connection.credential).toBe("1//rt");

    process.env.ENABLE_MOCK_PROVIDERS = "false";
    await disconnectCalendar(admin, orgId, adminUser.session.user.id);
    expect(await resolveCalendar(admin, orgId)).toBeNull();
    delete process.env.ENABLE_MOCK_PROVIDERS;
  });

  it("keeps calendar credentials unreadable to every client role", async () => {
    await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "s@x.example", refreshToken: "1//rt2", scopes: [] });
    for (const db of [adminUser.db, jordan.db, anonClient()]) {
      const { data } = await db.from("calendar_tokens").select("*").limit(1);
      expect(data ?? []).toHaveLength(0);
    }
    await disconnectCalendar(admin, orgId, adminUser.session.user.id);
  });

  it("lets only an admin change the calendar connection row", async () => {
    const write = (db: typeof jordan.db) =>
      db.from("calendar_connections").insert({ org_id: orgId, provider: "google", account_email: "x@y.example" });
    expect((await write(jordan.db)).error).not.toBeNull();
    expect((await write(manager.db)).error).not.toBeNull();
    const asAdmin = await write(adminUser.db);
    expect(asAdmin.error).toBeNull();
    await admin.from("calendar_connections").delete().eq("org_id", orgId);
  });
});

describe("tenant isolation for meetings", () => {
  it("hides another organization's meetings and attendees", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: freshRuntime() });

    const rivalSession = await sessionFor(rival.adminEmail);
    const { data: meetings } = await rivalSession.db.from("meetings").select("id").eq("id", meetingId);
    const { data: attendees } = await rivalSession.db.from("meeting_attendees").select("id").eq("meeting_id", meetingId);
    expect(meetings ?? []).toHaveLength(0);
    expect(attendees ?? []).toHaveLength(0);
  });

  it("cannot attach an attendee to another organization's meeting", async () => {
    const lead = await newLead();
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId, { use_calendar: false }) as never);
    const rivalSession = await sessionFor(rival.adminEmail);
    const attempt = await rivalSession.db.from("meeting_attendees").insert({ org_id: rival.orgId, meeting_id: meetingId, email: "spy@x.example", role: "guest" });
    expect(attempt.error).not.toBeNull();
  });

  it("a salesperson does not see a colleague's meetings", async () => {
    const priyaLead = await newLead({ assigneeId: await userIdOf(SEED_USERS.priya) });
    const priya = await sessionFor(SEED_USERS.priya);
    const { meetingId } = await createMeeting(priya.db, priya.session, input(priyaLead.leadId, { use_calendar: false }) as never);
    const { data } = await jordan.db.from("meetings").select("id").eq("id", meetingId);
    expect(data ?? []).toHaveLength(0);
  });
});

describe("per-salesperson calendars", () => {
  const googleOn = () => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
  };

  afterEach(async () => {
    await admin.from("calendar_connections").delete().eq("org_id", orgId);
  });

  it("puts a meeting on its host's own calendar, and on the shared one for everyone else", async () => {
    googleOn();
    const jordanId = jordan.session.user.id;
    const shared = await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "team@summit.example", refreshToken: "1//shared", scopes: [] });
    const mine = await saveCalendarConnection(admin, { orgId, userId: jordanId, accountEmail: "jordan@gmail.example", refreshToken: "1//jordan", scopes: [], personal: true });

    const forJordan = await resolveCalendar(admin, orgId, { hostUserId: jordanId });
    expect(forJordan).toMatchObject({ mode: "live", connectionId: mine.connectionId, ownerUserId: jordanId });
    expect(forJordan?.connection.credential).toBe("1//jordan");

    const forPriya = await resolveCalendar(admin, orgId, { hostUserId: await userIdOf(SEED_USERS.priya) });
    expect(forPriya).toMatchObject({ mode: "live", connectionId: shared.connectionId, ownerUserId: null });
    expect(forPriya?.connection.credential).toBe("1//shared");
  });

  it("works with only personal calendars: the host's is live, someone without one gets demo", async () => {
    googleOn();
    await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "jordan@gmail.example", refreshToken: "1//jordan", scopes: [], personal: true });

    expect((await resolveCalendar(admin, orgId, { hostUserId: jordan.session.user.id }))?.mode).toBe("live");
    expect((await resolveCalendar(admin, orgId, { hostUserId: await userIdOf(SEED_USERS.priya) }))?.mode).toBe("demo");
  });

  it("keeps using the calendar that holds a meeting's event, even after the host connects their own", async () => {
    const lead = await newLead();
    const { connectionId: sharedId } = await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "team@summit.example", refreshToken: "1//shared", scopes: [] });

    // Created on the shared calendar.
    const onShared: CalendarRuntime = { ...freshRuntime(), connectionId: sharedId, ownerUserId: null };
    const { meetingId } = await createMeeting(jordan.db, jordan.session, input(lead.leadId) as never, { calendar: onShared });
    expect((await meetingRow(meetingId)).calendar_connection_id).toBe(sharedId);

    // Jordan then connects a personal calendar; the existing meeting still resolves to the shared one.
    googleOn();
    await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "jordan@gmail.example", refreshToken: "1//jordan", scopes: [], personal: true });
    const target = await getMeetingCalendarTarget(jordan.db, jordan.session, meetingId);
    expect(target).toEqual({ hostUserId: jordan.session.user.id, connectionId: sharedId });
    expect((await resolveCalendar(admin, orgId, target))?.connectionId).toBe(sharedId);
  });

  it("records a personal calendar's failure on that connection, not on the org's calendar health", async () => {
    const lead = await newLead();
    await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "team@summit.example", refreshToken: "1//shared", scopes: [] });
    const { connectionId } = await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "jordan@gmail.example", refreshToken: "1//jordan", scopes: [], personal: true });

    // A "live" personal runtime whose provider fails (the mock fails on @fail.test guests).
    const personal: CalendarRuntime = { ...freshRuntime(), mode: "live", connectionId, ownerUserId: jordan.session.user.id };
    const { calendarSync } = await createMeeting(jordan.db, jordan.session, input(lead.leadId, { guest_emails: "x@fail.test" }) as never, { calendar: personal, admin });
    expect(calendarSync.status).toBe("failed");

    expect((await getPersonalCalendarConnection(admin, orgId, jordan.session.user.id))?.last_error).toMatch(/unavailable/i);
    const { data: health } = await admin.from("integration_health").select("status").eq("org_id", orgId).eq("provider", "google_calendar").single();
    expect(health?.status).toBe("connected");

    // The next success clears it.
    const lead2 = await newLead();
    await createMeeting(jordan.db, jordan.session, input(lead2.leadId) as never, { calendar: personal, admin });
    expect((await getPersonalCalendarConnection(admin, orgId, jordan.session.user.id))?.last_error).toBeNull();
  });

  it("disconnecting a personal calendar leaves the shared one alone", async () => {
    await saveCalendarConnection(admin, { orgId, userId: adminUser.session.user.id, accountEmail: "team@summit.example", refreshToken: "1//shared", scopes: [] });
    const { connectionId } = await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "jordan@gmail.example", refreshToken: "1//jordan", scopes: [], personal: true });

    await disconnectCalendar(admin, orgId, jordan.session.user.id, { personal: true });
    expect(await getPersonalCalendarConnection(admin, orgId, jordan.session.user.id)).toBeNull();
    expect(await getCalendarCredential(admin, connectionId)).toBeNull();
    expect(await getCalendarConnection(admin, orgId)).not.toBeNull();
  });

  it("reconnecting replaces a member's personal connection instead of adding a second", async () => {
    const first = await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "old@gmail.example", refreshToken: "1//old", scopes: [], personal: true });
    const second = await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "new@gmail.example", refreshToken: "1//new", scopes: [], personal: true });
    expect(second.connectionId).toBe(first.connectionId);
    expect((await getPersonalCalendarConnection(admin, orgId, jordan.session.user.id))?.account_email).toBe("new@gmail.example");
    expect(await getCalendarCredential(admin, second.connectionId)).toBe("1//new");
  });

  it("lets a member write only their own personal connection row, and never read tokens", async () => {
    const priyaId = await userIdOf(SEED_USERS.priya);
    const own = await jordan.db.from("calendar_connections").insert({ org_id: orgId, user_id: jordan.session.user.id, provider: "google", account_email: "j@x.example" });
    expect(own.error).toBeNull();
    const someoneElses = await jordan.db.from("calendar_connections").insert({ org_id: orgId, user_id: priyaId, provider: "google", account_email: "p@x.example" });
    expect(someoneElses.error).not.toBeNull();

    await saveCalendarConnection(admin, { orgId, userId: jordan.session.user.id, accountEmail: "j@x.example", refreshToken: "1//secret", scopes: [], personal: true });
    const { data } = await jordan.db.from("calendar_tokens").select("*");
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot attach a personal connection to a member of another organization", async () => {
    const attempt = await admin.from("calendar_connections").insert({ org_id: orgId, user_id: rival.adminId, provider: "google", account_email: "r@x.example" });
    expect(attempt.error).not.toBeNull();
  });
});
