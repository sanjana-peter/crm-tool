import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InstagramGraphClient } from "@/lib/integrations/instagram/client";
import { getInstagramConfig } from "@/lib/integrations/instagram/config";
import { InstagramGraphProvider } from "@/lib/integrations/instagram/graph-adapter";
import { MockInstagramProvider } from "@/lib/integrations/instagram/mock-adapter";
import { getMockWebhookSecret } from "@/lib/integrations/mock/config";
import { mockProvidersEnabled } from "@/lib/integrations/mode";
import type { InstagramProvider } from "@/lib/ports/instagram";
import type { InstagramRuntime } from "@/lib/services/instagram-conversations";
import { getInstagramConnection, getInstagramToken } from "@/lib/services/instagram";

/**
 * The composition root for Instagram DMs: the one place that decides which
 * adapter an organization uses (DECISIONS D-017, D-030).
 *
 *  - The org connected its account and the Instagram app is configured → the
 *    real Instagram API ("live").
 *  - Otherwise, if mock providers are enabled → the mock ("demo").
 *  - Otherwise → null: Instagram is unavailable and the UI says so.
 */
export async function resolveInstagram(admin: SupabaseClient, orgId: string): Promise<InstagramRuntime | null> {
  const connection = await getInstagramConnection(admin, orgId);

  if (connection) {
    const config = getInstagramConfig();
    const token = config ? await getInstagramToken(admin, orgId) : null;
    if (config && token) {
      return {
        provider: new InstagramGraphProvider(config),
        connection: { accountId: connection.ig_user_id, accessToken: token },
        mode: "live",
      };
    }
  }

  if (mockProvidersEnabled()) {
    return {
      provider: new MockInstagramProvider(getMockWebhookSecret() ?? "unused-in-send-path"),
      connection: { accountId: `mock:${orgId}`, accessToken: "mock" },
      mode: "demo",
    };
  }

  return null;
}

/** Every provider whose webhook signature this deployment can verify, tried in order. */
export function instagramWebhookProviders(): InstagramProvider[] {
  const providers: InstagramProvider[] = [];

  const config = getInstagramConfig();
  if (config) providers.push(new InstagramGraphProvider(config));

  const mockSecret = getMockWebhookSecret();
  if (mockSecret) providers.push(new MockInstagramProvider(mockSecret));

  return providers;
}

/** A Graph client for connection management (OAuth, refresh, unsubscribe), or null if the app isn't configured. */
export function instagramGraphClient(): InstagramGraphClient | null {
  const config = getInstagramConfig();
  return config ? new InstagramGraphClient(config) : null;
}

export type InstagramMode = "live" | "demo" | "unavailable";

/**
 * Which mode Instagram is in for an org, for the UI — without reading the
 * token. Mirrors `resolveInstagram`; safe with an RLS-scoped client.
 */
export async function instagramMode(db: SupabaseClient, orgId: string): Promise<InstagramMode> {
  const connection = await getInstagramConnection(db, orgId);
  if (connection && getInstagramConfig()) return "live";
  return mockProvidersEnabled() ? "demo" : "unavailable";
}
