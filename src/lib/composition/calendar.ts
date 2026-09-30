import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleCalendarProvider } from "@/lib/integrations/google/calendar-adapter";
import { getGoogleConfig } from "@/lib/integrations/google/config";
import { MockCalendarProvider } from "@/lib/integrations/google/mock-adapter";
import { mockProvidersEnabled } from "@/lib/integrations/mode";
import {
  getCalendarConnection,
  getCalendarConnectionById,
  getCalendarCredential,
  getPersonalCalendarConnection,
  type CalendarConnectionRow,
} from "@/lib/services/calendar-connections";
import type { CalendarRuntime, CalendarTarget } from "@/lib/services/meetings";

/**
 * The composition root for calendars — the one place that decides which
 * adapter and which connected calendar a meeting uses (docs/ARCHITECTURE.md,
 * DECISIONS D-015/D-017). Adding DaySchedule or Calendly's API means another
 * branch here and a new adapter; meetings, the timeline and the UI don't change.
 *
 *  - A meeting whose event already exists → the connection that holds it.
 *  - Otherwise the host's personal Google calendar, else the org's shared one
 *    ("live", when the app has Google credentials).
 *  - Otherwise, if mock providers are enabled → the mock ("demo").
 *  - Otherwise → null: no calendar. Meetings still work with a pasted link.
 */
export async function resolveCalendar(
  admin: SupabaseClient,
  orgId: string,
  target: CalendarTarget = {}
): Promise<CalendarRuntime | null> {
  const config = getGoogleConfig();

  if (config) {
    const candidates: Array<CalendarConnectionRow | null> = target.connectionId
      ? [await getCalendarConnectionById(admin, orgId, target.connectionId)]
      : [
          target.hostUserId ? await getPersonalCalendarConnection(admin, orgId, target.hostUserId) : null,
          await getCalendarConnection(admin, orgId),
        ];

    for (const connection of candidates) {
      if (!connection) continue;
      const credential = await getCalendarCredential(admin, connection.id);
      if (!credential) continue;
      return {
        provider: new GoogleCalendarProvider(config),
        connection: { calendarId: connection.calendar_id, credential },
        mode: "live",
        connectionId: connection.id,
        ownerUserId: connection.user_id,
      };
    }
  }

  if (mockProvidersEnabled()) {
    return {
      provider: new MockCalendarProvider(),
      connection: { calendarId: "primary", credential: "mock" },
      mode: "demo",
      connectionId: null,
      ownerUserId: null,
    };
  }
  return null;
}

export type CalendarMode = "live" | "demo" | "unavailable";

/**
 * Which mode the calendar is in for meetings `userId` hosts, for the UI —
 * without reading any credential. Live when they have their own calendar or
 * the org has a shared one.
 */
export async function calendarMode(db: SupabaseClient, orgId: string, userId?: string): Promise<CalendarMode> {
  if (getGoogleConfig()) {
    const [shared, personal] = await Promise.all([
      getCalendarConnection(db, orgId),
      userId ? getPersonalCalendarConnection(db, orgId, userId) : Promise.resolve(null),
    ]);
    if (shared || personal) return "live";
  }
  return mockProvidersEnabled() ? "demo" : "unavailable";
}
