import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { recordAudit } from "@/lib/services/audit";
import { markConnected, markDisconnected } from "@/lib/services/integration-health";

/**
 * An org has at most one *shared* calendar connection (`user_id` null, managed
 * by an admin) and at most one *personal* connection per member. A meeting
 * goes on its host's personal calendar when they have one, else the shared
 * one (`composition/calendar.ts`).
 */
export interface CalendarConnectionRow {
  id: string;
  org_id: string;
  /** Null for the org's shared calendar; the owner's id for a personal one. */
  user_id: string | null;
  provider: "google";
  account_email: string;
  calendar_id: string;
  scopes: string[];
  connected_at: string;
  last_error: string | null;
  last_error_at: string | null;
}

const UNIQUE_VIOLATION = "23505";

/** The org's shared calendar connection. */
export async function getCalendarConnection(db: SupabaseClient, orgId: string): Promise<CalendarConnectionRow | null> {
  const { data, error } = await db
    .from("calendar_connections")
    .select("*")
    .eq("org_id", orgId)
    .is("user_id", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to load calendar connection: ${error.message}`);
  return (data as CalendarConnectionRow | null) ?? null;
}

/** A member's own calendar connection. */
export async function getPersonalCalendarConnection(
  db: SupabaseClient,
  orgId: string,
  userId: string
): Promise<CalendarConnectionRow | null> {
  const { data, error } = await db
    .from("calendar_connections")
    .select("*")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load your calendar connection: ${error.message}`);
  return (data as CalendarConnectionRow | null) ?? null;
}

export async function getCalendarConnectionById(
  db: SupabaseClient,
  orgId: string,
  connectionId: string
): Promise<CalendarConnectionRow | null> {
  const { data, error } = await db
    .from("calendar_connections")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load calendar connection: ${error.message}`);
  return (data as CalendarConnectionRow | null) ?? null;
}

/** Every personal connection in the org, keyed by owner — for the team overview. */
export async function listPersonalCalendarConnections(
  db: SupabaseClient,
  orgId: string
): Promise<Map<string, CalendarConnectionRow>> {
  const { data, error } = await db
    .from("calendar_connections")
    .select("*")
    .eq("org_id", orgId)
    .not("user_id", "is", null);
  if (error) throw new Error(`Failed to load calendar connections: ${error.message}`);
  return new Map(((data ?? []) as CalendarConnectionRow[]).map((row) => [row.user_id as string, row]));
}

/** A connection's stored refresh token, decrypted. Service role only: the table has no client access. */
export async function getCalendarCredential(admin: SupabaseClient, connectionId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("calendar_tokens")
    .select("refresh_token")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load calendar credential: ${error.message}`);
  return data?.refresh_token ? decryptSecret(data.refresh_token as string) : null;
}

/**
 * Persists a completed OAuth handshake: the account identity, and the refresh
 * token encrypted at rest. `personal: true` saves it as the connecting user's
 * own calendar; otherwise it becomes the org's shared calendar.
 */
export async function saveCalendarConnection(
  admin: SupabaseClient,
  params: {
    orgId: string;
    userId: string;
    accountEmail: string;
    refreshToken: string;
    scopes: string[];
    personal?: boolean;
  }
): Promise<{ connectionId: string }> {
  const ownerId = params.personal ? params.userId : null;
  const fields = {
    provider: "google",
    account_email: params.accountEmail,
    scopes: params.scopes,
    connected_by: params.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
  };

  // Partial unique indexes (one shared, one per member) can't be an upsert
  // target, so: update if present, else insert — and if a concurrent callback
  // inserted first, update theirs.
  const findExisting = () =>
    ownerId ? getPersonalCalendarConnection(admin, params.orgId, ownerId) : getCalendarConnection(admin, params.orgId);

  const updateExisting = async (id: string) => {
    const { error } = await admin.from("calendar_connections").update(fields).eq("id", id).eq("org_id", params.orgId);
    if (error) throw new Error(`Failed to save calendar connection: ${error.message}`);
    return id;
  };

  let connectionId: string;
  const existing = await findExisting();
  if (existing) {
    connectionId = await updateExisting(existing.id);
  } else {
    const { data, error } = await admin
      .from("calendar_connections")
      .insert({ org_id: params.orgId, user_id: ownerId, ...fields })
      .select("id")
      .single();
    if (!error) {
      connectionId = data.id as string;
    } else if (error.code === UNIQUE_VIOLATION) {
      const raced = await findExisting();
      if (!raced) throw new Error("Failed to save calendar connection.");
      connectionId = await updateExisting(raced.id);
    } else {
      throw new Error(`Failed to save calendar connection: ${error.message}`);
    }
  }

  const { error: tokenError } = await admin.from("calendar_tokens").upsert(
    {
      connection_id: connectionId,
      org_id: params.orgId,
      refresh_token: encryptSecret(params.refreshToken),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id" }
  );
  if (tokenError) throw new Error(`Failed to save calendar credential: ${tokenError.message}`);

  // Org-level health describes the shared calendar; a personal connection
  // reports its own state on its row (`last_error`).
  if (!ownerId) await markConnected(admin, params.orgId, "google_calendar");
  await recordAudit(admin, {
    orgId: params.orgId,
    actorId: params.userId,
    action: "integration.connected",
    entityType: "integration",
    entityId: ownerId ? `google_calendar:${ownerId}` : "google_calendar",
    summary: ownerId
      ? `Connected their own Google Calendar (${params.accountEmail})`
      : `Connected Google Calendar (${params.accountEmail})`,
  });

  return { connectionId };
}

/** Disconnects the shared calendar, or with `personal: true` the acting user's own. */
export async function disconnectCalendar(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  options: { personal?: boolean } = {}
): Promise<void> {
  const connection = options.personal
    ? await getPersonalCalendarConnection(admin, orgId, userId)
    : await getCalendarConnection(admin, orgId);

  if (connection) {
    // Tokens cascade with the connection; meetings keep their event but lose the link to it.
    const { error } = await admin.from("calendar_connections").delete().eq("id", connection.id).eq("org_id", orgId);
    if (error) throw new Error(`Failed to disconnect Google Calendar: ${error.message}`);
  }

  if (!options.personal) await markDisconnected(admin, orgId, "google_calendar");
  await recordAudit(admin, {
    orgId,
    actorId: userId,
    action: "integration.disconnected",
    entityType: "integration",
    entityId: options.personal ? `google_calendar:${userId}` : "google_calendar",
    summary: options.personal ? "Disconnected their own Google Calendar" : "Disconnected Google Calendar",
  });
}

/** Records (or clears, with `error: null`) the last failure of a personal connection. */
export async function recordPersonalCalendarResult(
  admin: SupabaseClient,
  orgId: string,
  connectionId: string,
  error: string | null
): Promise<void> {
  await admin
    .from("calendar_connections")
    .update({ last_error: error?.slice(0, 500) ?? null, last_error_at: error ? new Date().toISOString() : null })
    .eq("id", connectionId)
    .eq("org_id", orgId);
}
