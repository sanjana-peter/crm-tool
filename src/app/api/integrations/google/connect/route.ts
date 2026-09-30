import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireRole, requireSession } from "@/lib/auth/session";
import { GoogleCalendarClient } from "@/lib/integrations/google/client";
import { getGoogleConfig } from "@/lib/integrations/google/config";
import { createSignedState } from "@/lib/security/oauth-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts the Google OAuth flow. `?scope=personal` connects the signed-in
 * member's own calendar (any role); otherwise an admin connects the org's
 * shared calendar.
 */
export async function GET(request: NextRequest) {
  const personal = request.nextUrl.searchParams.get("scope") === "personal";
  const session = personal ? await requireSession() : await requireRole(["admin"]);

  const config = getGoogleConfig();
  if (!config) redirect(personal ? "/settings?calendar_error=not_configured" : "/settings/integrations/google?error=not_configured");

  const state = createSignedState(config.clientSecret, session.orgId, session.user.id, { personal });
  redirect(new GoogleCalendarClient(config).authorizeUrl(state));
}
