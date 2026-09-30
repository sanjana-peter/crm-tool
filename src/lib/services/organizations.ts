import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserError } from "@/lib/domain/errors";
import { INVITABLE_ROLES, type InvitableRole } from "@/lib/domain/team";
import { recordAudit } from "@/lib/services/audit";

/**
 * The V1 default pipeline every new organization starts with. Every entry sets
 * is_default/is_won/is_lost explicitly: PostgREST's bulk insert unions the JSON
 * keys across the whole array into one shared column list, so a row whose
 * object omits a key present on another row gets an explicit `null` for it —
 * not the column's DB default, which only applies when a column is absent from
 * the statement entirely. A heterogeneous-shape array here would violate
 * lead_statuses' NOT NULL constraints instead of quietly defaulting to false.
 *
 * Stage *behaviour* is carried by the flags, never the label: `is_default` is
 * where a new lead enters; `is_won` / `is_lost` close it.
 */
export const DEFAULT_STATUSES: Array<{
  key: string;
  label: string;
  sort_order: number;
  is_default: boolean;
  is_won: boolean;
  is_lost: boolean;
}> = [
  { key: "new_lead", label: "New Lead", sort_order: 10, is_default: true, is_won: false, is_lost: false },
  { key: "contact_needed", label: "Contact Needed", sort_order: 20, is_default: false, is_won: false, is_lost: false },
  { key: "contacted", label: "Contacted", sort_order: 30, is_default: false, is_won: false, is_lost: false },
  { key: "interested", label: "Interested", sort_order: 40, is_default: false, is_won: false, is_lost: false },
  {
    key: "meeting_scheduled",
    label: "Meeting Scheduled",
    sort_order: 50,
    is_default: false,
    is_won: false,
    is_lost: false,
  },
  {
    key: "meeting_completed",
    label: "Meeting Completed",
    sort_order: 60,
    is_default: false,
    is_won: false,
    is_lost: false,
  },
  {
    key: "payment_pending",
    label: "Payment Pending",
    sort_order: 70,
    is_default: false,
    is_won: false,
    is_lost: false,
  },
  { key: "won", label: "Won", sort_order: 80, is_default: false, is_won: true, is_lost: false },
  { key: "lost", label: "Lost", sort_order: 90, is_default: false, is_won: false, is_lost: true },
];

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

async function uniqueSlug(admin: SupabaseClient, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let attempt = 0;

  // Practically never loops more than once — collisions require two orgs
  // with the same name, ever, on this deployment.
  while (attempt < 20) {
    const { data } = await admin.from("organizations").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  throw new Error("Could not generate a unique organization slug.");
}

/**
 * Creates a brand-new organization with its founding admin and default
 * pipeline. Requires the service-role admin client — RLS has no INSERT
 * policy on `organizations` at all (there is no session yet that could
 * satisfy "is a member of this org," since the org doesn't exist), so this
 * is one of the few operations in the app that must run with RLS bypassed
 * by design, not as a workaround.
 *
 * Best-effort compensation: if any step after creating the auth user fails,
 * the auth user is deleted so a failed signup doesn't leave an orphaned,
 * un-organized account the person can't recover on retry.
 */
export async function createOrganizationWithAdmin(
  admin: SupabaseClient,
  params: { orgName: string; email: string; password: string }
): Promise<{ orgId: string; userId: string }> {
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email: params.email,
    password: params.password,
    email_confirm: true,
  });
  if (userError || !created.user) {
    throw new Error(userError?.message ?? "Failed to create the admin account.");
  }
  const userId = created.user.id;

  let createdOrgId: string | null = null;

  try {
    const slug = await uniqueSlug(admin, params.orgName);

    const { data: org, error: orgError } = await admin
      .from("organizations")
      .insert({ name: params.orgName, slug })
      .select("id")
      .single();
    if (orgError) throw new Error(`Failed to create organization: ${orgError.message}`);
    const orgId = org.id as string;
    createdOrgId = orgId;

    const { error: memberError } = await admin
      .from("organization_members")
      .insert({ org_id: orgId, user_id: userId, role: "admin" });
    if (memberError) throw new Error(`Failed to create membership: ${memberError.message}`);

    const { data: pipeline, error: pipelineError } = await admin
      .from("pipelines")
      .insert({ org_id: orgId, name: "Sales Pipeline", is_default: true })
      .select("id")
      .single();
    if (pipelineError) throw new Error(`Failed to create pipeline: ${pipelineError.message}`);

    const { error: statusError } = await admin
      .from("lead_statuses")
      .insert(DEFAULT_STATUSES.map((s) => ({ org_id: orgId, pipeline_id: pipeline.id as string, ...s })));
    if (statusError) throw new Error(`Failed to seed pipeline: ${statusError.message}`);

    return { orgId, userId };
  } catch (e) {
    // Best-effort cleanup — surfacing the original error matters more than a
    // cleanup failure, and a leftover row is recoverable by hand later, unlike
    // losing the real failure reason. Deleting the org cascades to everything
    // created under it.
    if (createdOrgId) await admin.from("organizations").delete().eq("id", createdOrgId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw e;
  }
}

/**
 * Invites a manager or salesperson by email: creates their (unconfirmed) auth
 * user via Supabase's own invite flow — which emails them a link to set a
 * password — and adds them to the org. Same compensation approach as org
 * creation: a failed membership insert deletes the invited auth user rather
 * than leaving an invited-but-unassigned account. (Admins are made by
 * promotion, never by invitation: see domain/team.ts.)
 */
export async function inviteMember(
  admin: SupabaseClient,
  params: { orgId: string; email: string; role: InvitableRole; invitedBy?: string | null }
): Promise<{ userId: string }> {
  // The type already forbids inviting an admin; enforce it at runtime too, so a
  // future caller (or a forged value) can't grant admin as a side effect.
  if (!(INVITABLE_ROLES as readonly string[]).includes(params.role)) {
    throw new UserError("You can't invite someone as that role. Invite them, then change their role.");
  }

  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", params.email)
    .maybeSingle();
  if (existingProfile) {
    const { data: existingMembership } = await admin
      .from("organization_members")
      .select("org_id")
      .eq("user_id", existingProfile.id)
      .maybeSingle();
    if (existingMembership) {
      throw new UserError("That email already belongs to an organization on this platform.");
    }
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(params.email);
  if (inviteError || !invited.user) {
    throw new Error(inviteError?.message ?? "Failed to send the invitation.");
  }
  const userId = invited.user.id;

  const { error: memberError } = await admin
    .from("organization_members")
    // Salespeople join the round-robin rotation by default; managers opt in from /team.
    .insert({ org_id: params.orgId, user_id: userId, role: params.role, in_rotation: params.role === "salesperson" });

  if (memberError) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(`Failed to add them to the organization: ${memberError.message}`);
  }

  await recordAudit(admin, {
    orgId: params.orgId,
    actorId: params.invitedBy ?? null,
    action: "team.member_invited",
    entityType: "member",
    entityId: userId,
    summary: `Invited ${params.email} as ${params.role}`,
    metadata: { role: params.role },
  });

  return { userId };
}
