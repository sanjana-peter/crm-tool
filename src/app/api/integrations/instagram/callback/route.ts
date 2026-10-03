import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { UserError } from "@/lib/domain/errors";
import { InstagramGraphClient } from "@/lib/integrations/instagram/client";
import {
  getInstagramConfig,
  getInstagramOAuthRedirectUri,
  INSTAGRAM_OAUTH_SCOPES,
  INSTAGRAM_WEBHOOK_FIELDS,
} from "@/lib/integrations/instagram/config";
import { verifyInstagramOAuthState } from "@/lib/integrations/instagram/oauth";
import { logger } from "@/lib/observability/logger";
import { recordAudit } from "@/lib/services/audit";
import { saveInstagramConnection } from "@/lib/services/instagram";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SETTINGS_PATH = "/settings/integrations/instagram";

function back(request: NextRequest, params: Record<string, string>) {
  const url = new URL(SETTINGS_PATH, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const config = getInstagramConfig();
  if (!config) return back(request, { error: "not_configured" });

  const params = request.nextUrl.searchParams;
  if (params.get("error")) {
    return back(request, {
      error: "denied",
      detail: params.get("error_description") ?? params.get("error_reason") ?? params.get("error") ?? "",
    });
  }

  const code = params.get("code");
  if (!code) return back(request, { error: "missing_code" });

  const state = verifyInstagramOAuthState(config, params.get("state"));
  if (!state) return back(request, { error: "invalid_state" });

  const session = await requireRole(["admin"]);
  if (session.orgId !== state.orgId || session.user.id !== state.userId) {
    return back(request, { error: "state_mismatch" });
  }

  try {
    const graph = new InstagramGraphClient(config);
    // Instagram appends `#_` to the code it hands back; it isn't part of the code.
    const shortLived = await graph.exchangeCodeForToken(code.replace(/#_$/, ""), getInstagramOAuthRedirectUri(config));
    const longLived = await graph.exchangeForLongLivedToken(shortLived.access_token);
    const account = await graph.getAccount(longLived.access_token);

    // Without this subscription no DM ever reaches us; report it rather than pretend.
    let webhookSubscribed = true;
    try {
      await graph.subscribeWebhooks(longLived.access_token, INSTAGRAM_WEBHOOK_FIELDS);
    } catch (error) {
      webhookSubscribed = false;
      logger.warn("instagram.subscribe_failed", { orgId: session.orgId, error });
    }

    const admin = createAdminClient();
    await saveInstagramConnection(admin, {
      orgId: session.orgId,
      userId: session.user.id,
      account,
      accessToken: longLived.access_token,
      expiresInSeconds: longLived.expires_in,
      scopes: shortLived.permissions?.length ? shortLived.permissions : [...INSTAGRAM_OAUTH_SCOPES],
      webhookSubscribed,
    });
    await recordAudit(admin, {
      orgId: session.orgId,
      actorId: session.user.id,
      action: "integration.instagram_connected",
      entityType: "organization",
      entityId: session.orgId,
      summary: `Connected Instagram account @${account.username}`,
    });

    return back(request, webhookSubscribed ? { connected: "1" } : { connected: "1", error: "subscribe_failed" });
  } catch (e) {
    return back(request, {
      error: e instanceof UserError ? "already_connected" : "exchange_failed",
      detail: e instanceof Error ? e.message : "Unknown error",
    });
  }
}
