import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  manualAssignment,
  roundRobinAssignment,
  type AssignmentMode,
  type AssignmentStrategy,
} from "@/lib/domain/assignment";
import { UserError } from "@/lib/domain/errors";
import { recordAudit } from "@/lib/services/audit";

export async function getAssignmentMode(db: SupabaseClient, orgId: string): Promise<AssignmentMode> {
  const { data, error } = await db.from("organizations").select("lead_assignment_mode").eq("id", orgId).maybeSingle();
  if (error) throw new Error(`Failed to load the assignment setting: ${error.message}`);
  return data?.lead_assignment_mode === "round_robin" ? "round_robin" : "manual";
}

/**
 * The strategy for leads that arrive without a person choosing an assignee
 * (Meta, file import, the test source). `db` must be able to call
 * `next_rotation_assignee` for this org: the service role, or an admin/manager.
 */
export async function assignmentStrategyFor(db: SupabaseClient, orgId: string): Promise<AssignmentStrategy> {
  const mode = await getAssignmentMode(db, orgId);
  if (mode === "manual") return manualAssignment;

  return roundRobinAssignment(async (org) => {
    const { data, error } = await db.rpc("next_rotation_assignee", { p_org: org });
    if (error) throw new Error(`Failed to pick the next salesperson in the rotation: ${error.message}`);
    return (data as string | null) ?? null;
  });
}

export async function setAssignmentMode(
  admin: SupabaseClient,
  params: { orgId: string; actingUserId: string; mode: AssignmentMode }
): Promise<void> {
  const { error } = await admin
    .from("organizations")
    .update({ lead_assignment_mode: params.mode })
    .eq("id", params.orgId);
  if (error) throw new Error(`Failed to change lead assignment: ${error.message}`);

  await recordAudit(admin, {
    orgId: params.orgId,
    actorId: params.actingUserId,
    action: "settings.assignment_mode_changed",
    entityType: "organization",
    entityId: params.orgId,
    summary: params.mode === "round_robin" ? "Turned on round-robin lead assignment" : "Switched to manual lead assignment",
    metadata: { mode: params.mode },
  });
}

/** Adds a member to, or removes them from, the round-robin rotation. */
export async function setMemberInRotation(
  admin: SupabaseClient,
  params: { orgId: string; actingUserId: string; targetUserId: string; inRotation: boolean }
): Promise<void> {
  const { data, error } = await admin
    .from("organization_members")
    .update({ in_rotation: params.inRotation })
    .eq("org_id", params.orgId)
    .eq("user_id", params.targetUserId)
    .select("profile:user_id(email, full_name)")
    .maybeSingle();
  if (error) throw new Error(`Failed to update the rotation: ${error.message}`);
  if (!data) throw new UserError("That person is not a member of this organization.");

  const profile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { email: string; full_name: string | null }
    | null;
  const label = profile?.full_name || profile?.email || "team member";

  await recordAudit(admin, {
    orgId: params.orgId,
    actorId: params.actingUserId,
    action: params.inRotation ? "team.rotation_joined" : "team.rotation_left",
    entityType: "member",
    entityId: params.targetUserId,
    summary: `${params.inRotation ? "Added" : "Removed"} ${label} ${params.inRotation ? "to" : "from"} the lead rotation`,
  });
}
