import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { getInstagramConfig } from "@/lib/integrations/instagram/config";
import { buildInstagramAuthorizeUrl, createInstagramOAuthState } from "@/lib/integrations/instagram/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts Instagram Login for the signed-in admin's organization. */
export async function GET() {
  const session = await requireRole(["admin"]);

  const config = getInstagramConfig();
  if (!config) {
    redirect("/settings/integrations/instagram?error=not_configured");
  }

  const state = createInstagramOAuthState(config, session.orgId, session.user.id);
  redirect(buildInstagramAuthorizeUrl(config, state));
}
