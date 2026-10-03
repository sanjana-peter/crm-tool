"use server";

import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/session";
import { UserError } from "@/lib/domain/errors";
import { instagramGraphClient, resolveInstagram } from "@/lib/composition/instagram";
import { buildMockInstagramDm, mockInstagramSenderId } from "@/lib/integrations/instagram/mock-adapter";
import { recordAudit } from "@/lib/services/audit";
import { disconnectInstagram } from "@/lib/services/instagram";
import { handleInstagramEvents } from "@/lib/services/instagram-conversations";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAction, type ActionResult } from "@/lib/actions/run";

const SETTINGS_PATH = "/settings/integrations/instagram";
const paths = [SETTINGS_PATH, "/settings", "/settings/integrations"];

export async function disconnectInstagramAction(): Promise<ActionResult> {
  const session = await requireRole(["admin"]);
  const admin = createAdminClient();
  return runAction(
    "disconnectInstagram",
    async () => {
      await disconnectInstagram(admin, session.orgId, instagramGraphClient());
      await recordAudit(admin, {
        orgId: session.orgId,
        actorId: session.user.id,
        action: "integration.instagram_disconnected",
        entityType: "organization",
        entityId: session.orgId,
        summary: "Disconnected Instagram",
      });
    },
    paths
  );
}

const USERNAME = /^@?[a-z0-9._]{1,30}$/i;

/**
 * Demo mode only: pretend someone DMed the org's Instagram account, through
 * the very same inbound path a real webhook takes — a new username becomes a
 * new lead, a known one lands on their existing lead.
 */
export async function simulateInstagramDmAction(
  username: string,
  text: string
): Promise<ActionResult<{ leadId: string | null }>> {
  const session = await requireRole(["admin", "manager"]);
  const admin = createAdminClient();
  return runAction<{ leadId: string | null }>(
    "simulateInstagramDm",
    async () => {
      if (!USERNAME.test(username.trim())) throw new UserError("Enter an Instagram username, like @riya.sharma.");
      const body = text.trim().slice(0, 1000);
      if (!body) throw new UserError("Write the message they sent.");

      const runtime = await resolveInstagram(admin, session.orgId);
      if (!runtime || runtime.mode !== "demo") {
        throw new UserError("Simulated DMs are only available in demo mode.");
      }

      const senderId = mockInstagramSenderId(username);
      const payload = buildMockInstagramDm({ accountId: runtime.connection.accountId, senderId, text: body });
      await handleInstagramEvents(admin, {
        provider: runtime.provider,
        events: runtime.provider.parseWebhook(payload),
        requestId: randomUUID(),
      });

      const { data: contact } = await admin
        .from("contacts")
        .select("id")
        .eq("org_id", session.orgId)
        .eq("instagram_user_id", senderId)
        .maybeSingle();
      if (!contact) return { leadId: null };
      const { data: lead } = await admin
        .from("leads")
        .select("id")
        .eq("org_id", session.orgId)
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return { leadId: (lead?.id as string | undefined) ?? null };
    },
    [...paths, "/leads", "/"]
  );
}
