import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { MetaGraphClient } from "@/lib/integrations/meta/client";
import { getMetaConfig, getOAuthRedirectUri, META_OAUTH_SCOPES } from "@/lib/integrations/meta/config";
import { verifyOAuthState } from "@/lib/integrations/meta/oauth";
import { createAdminClient } from "@/lib/supabase/admin";
import { saveConnection } from "@/lib/services/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SETTINGS_PATH = "/settings/integrations/meta";

function back(request: NextRequest, params: Record<string, string>) {
  const url = new URL(SETTINGS_PATH, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const config = getMetaConfig();
  if (!config) return back(request, { error: "not_configured" });

  const params = request.nextUrl.searchParams;

  // The user declined the Facebook dialog, or Meta rejected the request.
  if (params.get("error")) {
    return back(request, {
      error: "denied",
      detail: params.get("error_description") ?? params.get("error") ?? "",
    });
  }

  const code = params.get("code");
  if (!code) return back(request, { error: "missing_code" });

  const state = verifyOAuthState(config, params.get("state"));
  if (!state) return back(request, { error: "invalid_state" });

  // The signed state says which org started the flow; confirm the person
  // finishing it is still that same signed-in admin.
  const session = await requireRole(["admin"]);
  if (session.orgId !== state.orgId || session.user.id !== state.userId) {
    return back(request, { error: "state_mismatch" });
  }

  // Names the Graph call in flight so a failure says which step Meta rejected.
  let step = "code exchange";
  try {
    const graph = new MetaGraphClient(config);

    const shortLived = await graph.exchangeCodeForToken(code, getOAuthRedirectUri(config));
    step = "long-lived token exchange";
    const longLived = await graph.exchangeForLongLivedToken(shortLived.access_token);

    step = "fetching profile";
    const me = await graph.getMe(longLived.access_token);
    step = "listing Pages";
    const pages = await graph.listPages(longLived.access_token);

    if (pages.length === 0) {
      return back(request, { error: "no_pages" });
    }

    const expiresAt = longLived.expires_in
      ? new Date(Date.now() + longLived.expires_in * 1000).toISOString()
      : null;

    step = "saving connection";
    const admin = createAdminClient();
    await saveConnection(admin, {
      orgId: session.orgId,
      userId: session.user.id,
      metaUserId: me.id,
      metaUserName: me.name ?? null,
      userAccessToken: longLived.access_token,
      tokenExpiresAt: expiresAt,
      scopes: [...META_OAUTH_SCOPES],
      pages,
    });

    return back(request, { connected: "1" });
  } catch (e) {
    return back(request, {
      error: "exchange_failed",
      detail: `${step}: ${e instanceof Error ? e.message : "Unknown error"}`,
    });
  }
}
