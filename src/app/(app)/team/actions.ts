"use server";

import { requireRole } from "@/lib/auth/session";
import { runAction, type ActionResult } from "@/lib/actions/run";
import { isAssignmentMode } from "@/lib/domain/assignment";
import { UserError } from "@/lib/domain/errors";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { setAssignmentMode, setMemberInRotation } from "@/lib/services/assignment";
import { inviteMember } from "@/lib/services/organizations";
import { setMemberActive, setMemberRole } from "@/lib/services/team";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteMemberSchema, roleChangeSchema } from "@/lib/validation/auth";

export async function inviteMemberAction(email: string, role: string): Promise<ActionResult> {
  const parsed = inviteMemberSchema.safeParse({ email, role });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid invitation." };
  }

  const session = await requireRole(["admin"]);
  const admin = createAdminClient();

  return runAction(
    "inviteMember",
    async () => {
      // Invitations send email; cap them per org so a compromised admin session
      // (or a bug) can't be used to spam strangers from our domain.
      const limit = await checkRateLimit(admin, { key: `invite:org:${session.orgId}`, limit: 30, windowSeconds: 3600 }, { failOpen: false });
      if (!limit.allowed) throw new UserError("You've sent a lot of invitations recently. Please try again later.");

      await inviteMember(admin, { orgId: session.orgId, email: parsed.data.email, role: parsed.data.role, invitedBy: session.user.id });
    },
    ["/team"]
  );
}

export async function setMemberActiveAction(targetUserId: string, isActive: boolean): Promise<ActionResult> {
  const session = await requireRole(["admin"]);
  return runAction(
    "setMemberActive",
    () =>
      setMemberActive(createAdminClient(), {
        orgId: session.orgId,
        targetUserId,
        actingUserId: session.user.id,
        isActive,
      }),
    ["/team"]
  );
}

export async function setMemberRoleAction(targetUserId: string, role: string): Promise<ActionResult> {
  const parsed = roleChangeSchema.safeParse({ user_id: targetUserId, role });
  if (!parsed.success) return { ok: false, error: "Invalid role." };

  const session = await requireRole(["admin"]);
  return runAction(
    "setMemberRole",
    () =>
      setMemberRole(createAdminClient(), {
        orgId: session.orgId,
        targetUserId: parsed.data.user_id,
        actingUserId: session.user.id,
        role: parsed.data.role,
      }),
    ["/team", "/"]
  );
}

export async function setAssignmentModeAction(mode: string): Promise<ActionResult> {
  if (!isAssignmentMode(mode)) return { ok: false, error: "Invalid assignment mode." };

  const session = await requireRole(["admin"]);
  return runAction(
    "setAssignmentMode",
    () => setAssignmentMode(createAdminClient(), { orgId: session.orgId, actingUserId: session.user.id, mode }),
    ["/team"]
  );
}

export async function setMemberInRotationAction(targetUserId: string, inRotation: boolean): Promise<ActionResult> {
  if (!/^[0-9a-f-]{36}$/i.test(targetUserId) || typeof inRotation !== "boolean") {
    return { ok: false, error: "Invalid request." };
  }

  const session = await requireRole(["admin"]);
  return runAction(
    "setMemberInRotation",
    () =>
      setMemberInRotation(createAdminClient(), {
        orgId: session.orgId,
        actingUserId: session.user.id,
        targetUserId,
        inRotation,
      }),
    ["/team"]
  );
}
