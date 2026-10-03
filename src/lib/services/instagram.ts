import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "@/lib/domain/errors";
import { shouldRefreshToken } from "@/lib/domain/instagram";
import { logger } from "@/lib/observability/logger";
import type { InstagramAccountApi, InstagramAccountInfo } from "@/lib/ports/instagram";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { markConnected, markDisconnected, markFailing } from "@/lib/services/integration-health";

const UNIQUE_VIOLATION = "23505";

export interface InstagramConnectionRow {
  id: string;
  org_id: string;
  ig_user_id: string;
  username: string;
  name: string | null;
  profile_picture_url: string | null;
  scopes: string[];
  token_expires_at: string | null;
  token_refreshed_at: string | null;
  webhook_subscribed: boolean;
  connected_by: string | null;
  connected_at: string;
}

export async function getInstagramConnection(db: SupabaseClient, orgId: string): Promise<InstagramConnectionRow | null> {
  const { data, error } = await db.from("instagram_connections").select("*").eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(`Failed to load the Instagram connection: ${error.message}`);
  return (data as InstagramConnectionRow | null) ?? null;
}

/** The org's access token, decrypted. Service role only: the table has no client access. */
export async function getInstagramToken(admin: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await admin.from("instagram_tokens").select("access_token").eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(`Failed to load the Instagram token: ${error.message}`);
  return data?.access_token ? decryptSecret(data.access_token as string) : null;
}

async function storeToken(admin: SupabaseClient, orgId: string, accessToken: string, expiresAt: string | null) {
  const { error } = await admin.from("instagram_tokens").upsert(
    { org_id: orgId, access_token: encryptSecret(accessToken), expires_at: expiresAt, updated_at: new Date().toISOString() },
    { onConflict: "org_id" }
  );
  if (error) throw new Error(`Failed to save the Instagram token: ${error.message}`);
}

function expiryFrom(expiresInSeconds: number | undefined): string | null {
  return expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000).toISOString() : null;
}

/**
 * Persists a completed Instagram Login: the account identity and its
 * long-lived token (encrypted). An account already connected to another org is
 * refused — webhooks name only the account, so it can feed exactly one org.
 */
export async function saveInstagramConnection(
  admin: SupabaseClient,
  params: {
    orgId: string;
    userId: string;
    account: InstagramAccountInfo;
    accessToken: string;
    expiresInSeconds?: number;
    scopes: string[];
    webhookSubscribed: boolean;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = expiryFrom(params.expiresInSeconds);

  const { error } = await admin.from("instagram_connections").upsert(
    {
      org_id: params.orgId,
      ig_user_id: params.account.user_id,
      username: params.account.username,
      name: params.account.name ?? null,
      profile_picture_url: params.account.profile_picture_url ?? null,
      scopes: params.scopes,
      token_expires_at: expiresAt,
      token_refreshed_at: now,
      webhook_subscribed: params.webhookSubscribed,
      connected_by: params.userId,
      connected_at: now,
    },
    { onConflict: "org_id" }
  );
  if (error?.code === UNIQUE_VIOLATION) {
    throw new UserError(`@${params.account.username} is already connected to another organization.`);
  }
  if (error) throw new Error(`Failed to save the Instagram connection: ${error.message}`);

  await storeToken(admin, params.orgId, params.accessToken, expiresAt);
  await markConnected(admin, params.orgId, "instagram");
}

/** Stops webhook delivery (best effort) and forgets the account and its token. */
export async function disconnectInstagram(
  admin: SupabaseClient,
  orgId: string,
  graph: InstagramAccountApi | null
): Promise<void> {
  const token = await getInstagramToken(admin, orgId).catch(() => null);
  if (graph && token) {
    // If the token is already dead there's nothing to unsubscribe; carry on.
    await graph.unsubscribeWebhooks(token).catch((error) => logger.warn("instagram.unsubscribe_failed", { orgId, error }));
  }

  await admin.from("instagram_tokens").delete().eq("org_id", orgId);
  const { error } = await admin.from("instagram_connections").delete().eq("org_id", orgId);
  if (error) throw new Error(`Failed to disconnect Instagram: ${error.message}`);
  await markDisconnected(admin, orgId, "instagram");
}

export type RefreshOutcome = "refreshed" | "skipped" | "failed";

/** Extends one org's token if it's due. A rejected token marks the integration failing so an admin sees "Reconnect". */
export async function refreshInstagramToken(
  admin: SupabaseClient,
  graph: InstagramAccountApi,
  connection: Pick<InstagramConnectionRow, "org_id" | "token_refreshed_at" | "token_expires_at">,
  options: { force?: boolean } = {}
): Promise<RefreshOutcome> {
  const due = shouldRefreshToken({ refreshedAt: connection.token_refreshed_at, expiresAt: connection.token_expires_at });
  if (!due && !options.force) return "skipped";

  const orgId = connection.org_id;
  try {
    const token = await getInstagramToken(admin, orgId);
    if (!token) throw new Error("No stored Instagram token. Reconnect Instagram in Settings.");

    const refreshed = await graph.refreshLongLivedToken(token);
    const expiresAt = expiryFrom(refreshed.expires_in);
    await storeToken(admin, orgId, refreshed.access_token, expiresAt);
    await admin
      .from("instagram_connections")
      .update({ token_expires_at: expiresAt, token_refreshed_at: new Date().toISOString() })
      .eq("org_id", orgId);
    return "refreshed";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markFailing(admin, orgId, "instagram", `Couldn't renew the Instagram access (${reason}). Reconnect Instagram in Settings.`);
    logger.error("instagram.token_refresh_failed", { orgId, error });
    return "failed";
  }
}

/** The daily job: refresh every token that's due. */
export async function refreshDueInstagramTokens(
  admin: SupabaseClient,
  graph: InstagramAccountApi
): Promise<Record<RefreshOutcome, number>> {
  const { data, error } = await admin.from("instagram_connections").select("org_id, token_refreshed_at, token_expires_at");
  if (error) throw new Error(`Failed to list Instagram connections: ${error.message}`);

  const counts: Record<RefreshOutcome, number> = { refreshed: 0, skipped: 0, failed: 0 };
  for (const connection of (data ?? []) as Array<Pick<InstagramConnectionRow, "org_id" | "token_refreshed_at" | "token_expires_at">>) {
    counts[await refreshInstagramToken(admin, graph, connection)] += 1;
  }
  return counts;
}
