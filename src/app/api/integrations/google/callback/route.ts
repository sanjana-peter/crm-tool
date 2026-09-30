import { NextResponse, type NextRequest } from "next/server";
import { requireRole, requireSession } from "@/lib/auth/session";
import { GoogleCalendarClient } from "@/lib/integrations/google/client";
import { getGoogleConfig } from "@/lib/integrations/google/config";
import { logger } from "@/lib/observability/logger";
import { verifySignedState } from "@/lib/security/oauth-state";
import { saveCalendarConnection } from "@/lib/services/calendar-connections";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARED_PATH = "/settings/integrations/google";
/** A personal connection is managed from the member's own settings page. */
const PERSONAL_PATH = "/settings";

function back(request: NextRequest, personal: boolean, params: Record<string, string>) {
  const url = new URL(personal ? PERSONAL_PATH : SHARED_PATH, request.nextUrl.origin);
  // The personal card reads prefixed params so they can't collide with other settings messages.
  for (const [key, value] of Object.entries(params)) url.searchParams.set(personal ? `calendar_${key}` : key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const config = getGoogleConfig();
  if (!config) return back(request, false, { error: "not_configured" });

  const params = request.nextUrl.searchParams;

  // Only a verified state says whether this was a personal flow; until then, report on the shared page.
  const state = verifySignedState(config.clientSecret, params.get("state"));
  const personal = state?.personal === true;

  // The user declined Google's consent screen.
  if (params.get("error")) return back(request, personal, { error: "denied" });

  const code = params.get("code");
  if (!code) return back(request, personal, { error: "missing_code" });
  if (!state) return back(request, personal, { error: "invalid_state" });

  // The signed state says which org and user started the flow; confirm the
  // person finishing it is that same signed-in user (and, for the shared
  // calendar, still an admin).
  const session = personal ? await requireSession() : await requireRole(["admin"]);
  if (session.orgId !== state.orgId || session.user.id !== state.userId) {
    return back(request, personal, { error: "state_mismatch" });
  }

  try {
    const google = new GoogleCalendarClient(config);
    const tokens = await google.exchangeCode(code);

    // Google only returns a refresh token on first consent; `prompt=consent`
    // forces it, so its absence means the flow was tampered with or misconfigured.
    if (!tokens.refreshToken) return back(request, personal, { error: "no_refresh_token" });
    if (!tokens.scopes.some((scope) => scope.endsWith("/calendar.events"))) {
      return back(request, personal, { error: "missing_scope" });
    }

    const accountEmail = await google.getAccountEmail(tokens.accessToken);

    await saveCalendarConnection(createAdminClient(), {
      orgId: session.orgId,
      userId: session.user.id,
      accountEmail,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
      personal,
    });
    return back(request, personal, { connected: "1" });
  } catch (error) {
    logger.error("google.oauth_failed", { orgId: session.orgId, personal, error });
    return back(request, personal, { error: "exchange_failed" });
  }
}
