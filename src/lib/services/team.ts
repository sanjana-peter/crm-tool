import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionContext } from "@/lib/auth/session";
import { UserError } from "@/lib/domain/errors";
import type { OrgRole } from "@/lib/domain/permissions";
import { checkDeactivation, checkRoleChange } from "@/lib/domain/team";
import { recordAudit } from "@/lib/services/audit";

export async function listOrgMembers(supabase: SupabaseClient, session: SessionContext) {
  const { data, error } = await supabase
    .from("organization_members")
    .select("id, user_id, role, is_active, in_rotation, created_at, profile:user_id(id, email, full_name, avatar_url)")
    .eq("org_id", session.orgId)
    .order("created_at");

  if (error) throw new Error(`Failed to load team: ${error.message}`);
  return data ?? [];
}

async function loadMember(admin: SupabaseClient, orgId: string, userId: string) {
  const { data } = await admin
    .from("organization_members")
    .select("role, is_active, profile:user_id(email, full_name)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new UserError("That person is not a member of this organization.");
  const profile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as { email: string; full_name: string | null } | null;
  return { role: data.role as OrgRole, isActive: data.is_active !== false, label: profile?.full_name || profile?.email || "team member" };
}

async function activeAdminCount(admin: SupabaseClient, orgId: string): Promise<number> {
  const { count } = await admin
    .from("organization_members")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("role", "admin")
    .eq("is_active", true);
  return count ?? 0;
}

/**
 * Deactivation is enforced by Supabase Auth's own ban mechanism (the user's
 * next request fails session validation and the proxy middleware redirects
 * them to /login) — not by an RLS check. `is_active` on the membership row
 * is a display mirror only, kept in sync here, never itself the boundary.
 * See supabase/migrations/0006_org_onboarding.sql for the full rationale.
 */
export async function setMemberActive(
  admin: SupabaseClient,
  params: { orgId: string; targetUserId: string; actingUserId: string; isActive: boolean }
): Promise<void> {
  const target = await loadMember(admin, params.orgId, params.targetUserId);

  if (!params.isActive) {
    const check = checkDeactivation({
      actorId: params.actingUserId,
      targetId: params.targetUserId,
      targetRole: target.role,
      activeAdminCount: await activeAdminCount(admin, params.orgId),
    });
    if (!check.ok) throw new UserError(check.error);
  } else if (params.targetUserId === params.actingUserId) {
    throw new UserError("You can't deactivate your own account.");
  }

  const { error: banError } = await admin.auth.admin.updateUserById(params.targetUserId, {
    ban_duration: params.isActive ? "none" : "876000h",
  });
  if (banError) throw new Error(`Failed to update account access: ${banError.message}`);

  const { error: updateError } = await admin
    .from("organization_members")
    .update({ is_active: params.isActive })
    .eq("org_id", params.orgId)
    .eq("user_id", params.targetUserId);
  if (updateError) throw new Error(`Failed to update membership: ${updateError.message}`);

  await recordAudit(admin, {
    orgId: params.orgId,
    actorId: params.actingUserId,
    action: params.isActive ? "team.member_reactivated" : "team.member_deactivated",
    entityType: "member",
    entityId: params.targetUserId,
    summary: `${params.isActive ? "Reactivated" : "Deactivated"} ${target.label}`,
  });
}

/**
 * Changes a member's role (admin only — the caller enforces that). The one
 * invariant: an org always keeps at least one active admin.
 */
export async function setMemberRole(
  admin: SupabaseClient,
  params: { orgId: string; targetUserId: string; actingUserId: string; role: OrgRole }
): Promise<void> {
  const target = await loadMember(admin, params.orgId, params.targetUserId);

  const check = checkRoleChange({
    currentRole: target.role,
    newRole: params.role,
    activeAdminCount: await activeAdminCount(admin, params.orgId),
  });
  if (!check.ok) throw new UserError(check.error);

  const { error } = await admin
    .from("organization_members")
    .update({ role: params.role })
    .eq("org_id", params.orgId)
    .eq("user_id", params.targetUserId);
  if (error) throw new Error(`Failed to change role: ${error.message}`);

  await recordAudit(admin, {
    orgId: params.orgId,
    actorId: params.actingUserId,
    action: "team.role_changed",
    entityType: "member",
    entityId: params.targetUserId,
    summary: `Changed ${target.label} from ${target.role} to ${params.role}`,
    metadata: { from: target.role, to: params.role },
  });
}

export async function listLeadStatuses(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("lead_statuses")
    .select("*")
    .eq("org_id", orgId)
    .order("sort_order");

  if (error) throw new Error(`Failed to load lead statuses: ${error.message}`);
  return data ?? [];
}
