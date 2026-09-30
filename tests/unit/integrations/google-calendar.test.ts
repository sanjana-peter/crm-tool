import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyCalendarError, GoogleCalendarProvider } from "@/lib/integrations/google/calendar-adapter";
import { GoogleApiError, GoogleCalendarClient } from "@/lib/integrations/google/client";
import { MockCalendarProvider } from "@/lib/integrations/google/mock-adapter";
import { createSignedState, verifySignedState } from "@/lib/security/oauth-state";

const config = { clientId: "client-id", clientSecret: "client-secret", appUrl: "http://localhost:3000" };
const connection = { calendarId: "primary", credential: "1//refresh-token-secret" };

const event = {
  eventId: "f47ac10b58cc4372a5670e02b2c3d479",
  title: "Summit — meeting with Riya",
  description: "Discuss the programme",
  startsAt: "2026-09-20T09:30:00.000Z",
  endsAt: "2026-09-20T10:00:00.000Z",
  timezone: "Asia/Kolkata",
  attendees: [
    { email: "priya@firm.com", name: "Priya" },
    { email: "riya@example.com", name: null },
  ],
  withVideoLink: true,
};

type Call = { url: string; method: string; body: string | null };

/** Routes requests by URL, like a tiny fake Google. */
function fakeGoogle(routes: Record<string, () => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      // A form body arrives as URLSearchParams; String() gives its wire form.
      calls.push({ url, method: init?.method ?? "GET", body: init?.body == null ? null : String(init.body) });
      const key = Object.keys(routes).find((k) => url.includes(k));
      const { status = 200, body = {} } = key ? routes[key]() : { status: 404, body: { error: { message: "no route" } } };
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("GoogleCalendarProvider.createEvent", () => {
  it("refreshes an access token, then inserts the event with a Meet request and our own event id", async () => {
    const calls = fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.access" } }),
      "/calendars/primary/events": () => ({
        body: { id: event.eventId, htmlLink: "https://calendar.google.com/x", hangoutLink: "https://meet.google.com/abc-defg-hij" },
      }),
    });

    const outcome = await new GoogleCalendarProvider(config).createEvent(connection, event);

    expect(outcome).toEqual({
      ok: true,
      externalEventId: event.eventId,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      eventUrl: "https://calendar.google.com/x",
    });

    const insert = calls.find((c) => c.url.includes("/events"))!;
    expect(insert.method).toBe("POST");
    expect(insert.url).toContain("conferenceDataVersion=1");
    expect(insert.url).toContain("sendUpdates=all");
    const body = JSON.parse(insert.body!);
    expect(body).toMatchObject({
      id: event.eventId,
      summary: event.title,
      start: { dateTime: event.startsAt, timeZone: "Asia/Kolkata" },
      end: { dateTime: event.endsAt, timeZone: "Asia/Kolkata" },
      attendees: [{ email: "priya@firm.com", displayName: "Priya" }, { email: "riya@example.com" }],
      conferenceData: { createRequest: { requestId: event.eventId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });

    // The refresh token is exchanged at the token endpoint and never sent to the Calendar API.
    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!;
    expect(tokenCall.body).toContain("grant_type=refresh_token");
    expect(insert.body).not.toContain("refresh-token-secret");
  });

  it("does not ask for a Meet link when a video link was supplied", async () => {
    const calls = fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.access" } }),
      "/events": () => ({ body: { id: event.eventId } }),
    });
    await new GoogleCalendarProvider(config).createEvent(connection, { ...event, withVideoLink: false });
    const insert = calls.find((c) => c.url.includes("/events"))!;
    expect(insert.url).not.toContain("conferenceDataVersion");
    expect(JSON.parse(insert.body!).conferenceData).toBeUndefined();
  });

  it("is idempotent: a 409 for an event we already created fetches it instead of booking twice", async () => {
    const calls = fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.access" } }),
      [`/events/${event.eventId}`]: () => ({ body: { id: event.eventId, hangoutLink: "https://meet.google.com/existing" } }),
      "/events?": () => ({ status: 409, body: { error: { message: "The requested identifier already exists." } } }),
    });

    const outcome = await new GoogleCalendarProvider(config).createEvent(connection, event);
    expect(outcome).toMatchObject({ ok: true, externalEventId: event.eventId, meetingUrl: "https://meet.google.com/existing" });
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/events?"))).toHaveLength(1);
    expect(calls.some((c) => c.method === "GET" && c.url.includes(`/events/${event.eventId}`))).toBe(true);
  });

  it("reports a revoked refresh token as an auth failure telling the admin to reconnect", async () => {
    fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }),
    });
    const outcome = await new GoogleCalendarProvider(config).createEvent(connection, event);
    expect(outcome).toMatchObject({ ok: false, code: "auth", retryable: false });
    expect((outcome as { error: string }).error).toMatch(/reconnect google calendar/i);
    expect(JSON.stringify(outcome)).not.toContain("refresh-token-secret");
  });

  it("never throws: a network failure becomes a retryable failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const outcome = await new GoogleCalendarProvider(config).createEvent(connection, event);
    expect(outcome).toMatchObject({ ok: false, code: "other", retryable: true });
  });
});

describe("GoogleCalendarProvider — update and cancel", () => {
  it("moves an event with a PATCH carrying only the new times", async () => {
    const calls = fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.access" } }),
      "/events/evt1": () => ({ body: { id: "evt1" } }),
    });
    const outcome = await new GoogleCalendarProvider(config).updateEventTime(connection, "evt1", {
      startsAt: "2026-09-21T09:30:00.000Z",
      endsAt: "2026-09-21T10:00:00.000Z",
      timezone: "Asia/Kolkata",
    });
    expect(outcome).toEqual({ ok: true });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(Object.keys(JSON.parse(patch.body!)).sort()).toEqual(["end", "start"]);
  });

  it("treats cancelling an already-deleted event as success", async () => {
    fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.access" } }),
      "/events/gone": () => ({ status: 410, body: { error: { message: "Resource has been deleted" } } }),
    });
    expect(await new GoogleCalendarProvider(config).cancelEvent(connection, "gone")).toEqual({ ok: true });
  });

  it("surfaces a real failure to cancel", async () => {
    fakeGoogle({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.access" } }),
      "/events/evt": () => ({ status: 500, body: { error: { message: "Backend Error" } } }),
    });
    expect(await new GoogleCalendarProvider(config).cancelEvent(connection, "evt")).toMatchObject({ ok: false, retryable: true });
  });
});

describe("classifyCalendarError", () => {
  it.each([
    [new GoogleApiError("expired", 401), "auth", false],
    [new GoogleApiError("bad grant", 400, "invalid_grant"), "auth", false],
    [new GoogleApiError("insufficient", 403, "insufficientPermissions"), "auth", false],
    [new GoogleApiError("slow down", 403, "rateLimitExceeded"), "rate_limited", true],
    [new GoogleApiError("slow down", 429), "rate_limited", true],
    [new GoogleApiError("boom", 503), "other", true],
    [new GoogleApiError("bad time", 400, "badRequest"), "invalid_request", false],
  ] as const)("maps %j to %s (retryable: %s)", (error, code, retryable) => {
    expect(classifyCalendarError(error)).toMatchObject({ ok: false, code, retryable });
  });
});

describe("GoogleCalendarClient.authorizeUrl", () => {
  it("asks for offline access, forced consent, and only the events scope", () => {
    const url = new URL(new GoogleCalendarClient(config).authorizeUrl("signed-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/integrations/google/callback");
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar"); // not full calendar access
  });
});

describe("MockCalendarProvider", () => {
  const mock = new MockCalendarProvider();

  it("is labelled a mock and fabricates a clearly fake event and link", async () => {
    expect(mock.isMock).toBe(true);
    const outcome = await mock.createEvent(connection, event);
    expect(outcome).toMatchObject({ ok: true, externalEventId: `mock.event.${event.eventId}` });
    expect((outcome as { meetingUrl: string }).meetingUrl).toContain("demo-");
  });

  it("fails, retryably, when an attendee is at fail.test", async () => {
    const outcome = await mock.createEvent(connection, { ...event, attendees: [{ email: "x@fail.test" }] });
    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });
});

describe("signed OAuth state", () => {
  const secret = "some-server-secret";

  it("round-trips who started the flow", () => {
    expect(verifySignedState(secret, createSignedState(secret, "org-1", "user-1"))).toEqual({ orgId: "org-1", userId: "user-1" });
  });

  it("carries a signed personal flag that can't be added by editing the payload", () => {
    const personal = createSignedState(secret, "org-1", "user-1", { personal: true });
    expect(verifySignedState(secret, personal)).toEqual({ orgId: "org-1", userId: "user-1", personal: true });

    const [, signature] = createSignedState(secret, "org-1", "user-1").split(".");
    const flipped = Buffer.from(
      JSON.stringify({ orgId: "org-1", userId: "user-1", personal: true, nonce: "x", issuedAt: Date.now() })
    ).toString("base64url");
    expect(verifySignedState(secret, `${flipped}.${signature}`)).toBeNull();
  });

  it("rejects a state signed with another secret, a tampered payload, and junk", () => {
    const state = createSignedState(secret, "org-1", "user-1");
    expect(verifySignedState("other-secret", state)).toBeNull();

    const [payload, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ orgId: "victim-org", userId: "user-1", nonce: "x", issuedAt: Date.now() })).toString("base64url");
    expect(verifySignedState(secret, `${forged}.${signature}`)).toBeNull();
    expect(verifySignedState(secret, `${payload}.`)).toBeNull();
    expect(verifySignedState(secret, "garbage")).toBeNull();
    expect(verifySignedState(secret, null)).toBeNull();
  });

  it("expires after ten minutes", () => {
    vi.useFakeTimers();
    try {
      const state = createSignedState(secret, "org-1", "user-1");
      vi.advanceTimersByTime(9 * 60_000);
      expect(verifySignedState(secret, state)).not.toBeNull();
      vi.advanceTimersByTime(2 * 60_000);
      expect(verifySignedState(secret, state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
