import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { manualAssignment } from "@/lib/domain/assignment";
import {
  assignmentStrategyFor,
  getAssignmentMode,
  setAssignmentMode,
  setMemberInRotation,
} from "@/lib/services/assignment";
import { captureLead } from "@/lib/services/capture";
import { importLeadsFromCsv } from "@/lib/services/file-import";
import {
  PASSWORD,
  SEED_USERS,
  SYSTEM,
  admin,
  anonClient,
  createRivalOrg,
  manualInput,
  seedOrgId,
  sessionFor,
  uniqueEmail,
  uniquePhone,
} from "./support";

/**
 * Round-robin runs in a fresh org of its own, so turning it on can't change
 * how leads are assigned in any other suite's seed data.
 */
let org: Awaited<ReturnType<typeof createRivalOrg>>;
let reps: string[] = [];
const createdUsers: string[] = [];

async function addMember(orgId: string, role: "salesperson" | "manager", inRotation: boolean): Promise<{ id: string; email: string }> {
  const email = `rr.${randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  createdUsers.push(data.user.id);
  const { error: memberError } = await admin
    .from("organization_members")
    .insert({ org_id: orgId, user_id: data.user.id, role, in_rotation: inRotation });
  if (memberError) throw new Error(`membership: ${memberError.message}`);
  return { id: data.user.id, email };
}

async function captureRoundRobin(overrides = {}) {
  const result = await captureLead(
    admin,
    SYSTEM(org.orgId),
    manualInput({ email: uniqueEmail("rr"), ...overrides }),
    { assignment: await assignmentStrategyFor(admin, org.orgId) }
  );
  if (result.outcome !== "created") throw new Error(`expected created, got ${result.outcome}`);
  return result;
}

function tally(ids: Array<string | null>) {
  const counts = new Map<string | null, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

beforeAll(async () => {
  org = await createRivalOrg();
  reps = [];
  for (let i = 0; i < 3; i++) reps.push((await addMember(org.orgId, "salesperson", true)).id);
});

afterAll(async () => {
  await org?.cleanup();
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

beforeEach(async () => {
  await admin.from("organizations").update({ lead_assignment_mode: "round_robin" }).eq("id", org.orgId);
  await admin.from("organization_members").update({ in_rotation: true, is_active: true }).in("user_id", reps);
  // The org's founding admin stays out of the rotation, as the migration default would have it.
  await admin.from("organization_members").update({ in_rotation: false }).eq("user_id", org.adminId);
});

describe("choosing the strategy", () => {
  it("is manual by default, and manual leaves an unrouted lead in the unassigned pool", async () => {
    const other = await createRivalOrg();
    try {
      expect(await getAssignmentMode(admin, other.orgId)).toBe("manual");
      expect(await assignmentStrategyFor(admin, other.orgId)).toBe(manualAssignment);
      const result = await captureLead(admin, SYSTEM(other.orgId), manualInput(), {
        assignment: await assignmentStrategyFor(admin, other.orgId),
      });
      expect(result).toMatchObject({ outcome: "created", assigneeId: null });
    } finally {
      await other.cleanup();
    }
  });

  it("changing the mode and the rotation is audited", async () => {
    await setAssignmentMode(admin, { orgId: org.orgId, actingUserId: org.adminId, mode: "manual" });
    await setAssignmentMode(admin, { orgId: org.orgId, actingUserId: org.adminId, mode: "round_robin" });
    await setMemberInRotation(admin, { orgId: org.orgId, actingUserId: org.adminId, targetUserId: reps[0], inRotation: false });
    await setMemberInRotation(admin, { orgId: org.orgId, actingUserId: org.adminId, targetUserId: reps[0], inRotation: true });

    const { data } = await admin.from("audit_events").select("action").eq("org_id", org.orgId);
    const actions = (data ?? []).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(["settings.assignment_mode_changed", "team.rotation_left", "team.rotation_joined"])
    );
  });

  it("refuses to change the rotation of someone outside the organization", async () => {
    const outsider = await createRivalOrg();
    try {
      await expect(
        setMemberInRotation(admin, { orgId: org.orgId, actingUserId: org.adminId, targetUserId: outsider.adminId, inRotation: true })
      ).rejects.toThrow(/not a member/i);
    } finally {
      await outsider.cleanup();
    }
  });
});

describe("round-robin", () => {
  it("deals leads out in turn, cycling through everyone in the rotation", async () => {
    const assigned: Array<string | null> = [];
    for (let i = 0; i < 6; i++) assigned.push((await captureRoundRobin()).assigneeId);

    expect(new Set(assigned.slice(0, 3))).toEqual(new Set(reps));
    expect(assigned.slice(3)).toEqual(assigned.slice(0, 3)); // same order the second time round
  });

  it("gives concurrent deliveries distinct turns (no one gets two while another gets none)", async () => {
    const results = await Promise.all(Array.from({ length: 9 }, () => captureRoundRobin()));
    const counts = tally(results.map((r) => r.assigneeId));
    expect([...counts.keys()].sort()).toEqual([...reps].sort());
    expect([...counts.values()]).toEqual([3, 3, 3]);
  });

  it("skips people taken out of the rotation and deactivated members", async () => {
    await setMemberInRotation(admin, { orgId: org.orgId, actingUserId: org.adminId, targetUserId: reps[1], inRotation: false });
    await admin.from("organization_members").update({ is_active: false }).eq("user_id", reps[2]);

    const assigned = [];
    for (let i = 0; i < 3; i++) assigned.push((await captureRoundRobin()).assigneeId);
    expect(assigned).toEqual([reps[0], reps[0], reps[0]]);
  });

  it("includes a manager who has opted in", async () => {
    const manager = await addMember(org.orgId, "manager", true);
    try {
      const assigned = [];
      for (let i = 0; i < 4; i++) assigned.push((await captureRoundRobin()).assigneeId);
      expect(new Set(assigned)).toEqual(new Set([...reps, manager.id]));
    } finally {
      await admin.from("organization_members").delete().eq("user_id", manager.id);
    }
  });

  it("leaves the lead unassigned when nobody is in the rotation", async () => {
    await admin.from("organization_members").update({ in_rotation: false }).eq("org_id", org.orgId);
    expect((await captureRoundRobin()).assigneeId).toBeNull();
  });

  it("lets an explicit assignee win without using up anyone's turn", async () => {
    const before = (await captureRoundRobin()).assigneeId;
    const explicit = await captureRoundRobin({ assigneeId: reps[0] });
    expect(explicit.assigneeId).toBe(reps[0]);

    // The rotation carries on from `before`, as if the explicit lead never happened.
    const next = (await captureRoundRobin()).assigneeId;
    const order = [...reps].sort();
    expect(next).toBe(order[(order.indexOf(before as string) + 1) % order.length]);
  });

  it("says on the timeline that round-robin made the assignment", async () => {
    const { leadId } = await captureRoundRobin();
    const { data } = await admin
      .from("activities")
      .select("description, metadata")
      .eq("lead_id", leadId)
      .eq("activity_type", "lead_assigned")
      .single();
    expect(data?.description).toMatch(/by round-robin/);
    expect(data?.metadata).toMatchObject({ strategy: "round_robin" });
  });

  it("assigns leads imported from a file under the admin's own session", async () => {
    const orgAdmin = await sessionFor(org.adminEmail);
    const csv = `first_name,phone\nImportA,${uniquePhone()}\nImportB,${uniquePhone()}\nImportC,${uniquePhone()}\n`;
    const summary = await importLeadsFromCsv(
      { db: orgAdmin.db, admin },
      { orgId: org.orgId, userId: orgAdmin.session.user.id, role: "admin" },
      csv,
      "rr.csv"
    );
    expect(summary.created).toBe(3);

    const { data } = await admin
      .from("leads")
      .select("assigned_to")
      .eq("org_id", org.orgId)
      .in("first_name", ["ImportA", "ImportB", "ImportC"]);
    expect(new Set((data ?? []).map((row) => row.assigned_to))).toEqual(new Set(reps));
  });
});

describe("who may take a turn", () => {
  it("only the service role or an admin/manager of that org can advance the rotation", async () => {
    const rep = await sessionFor(SEED_USERS.jordan);
    const seedAdmin = await sessionFor(SEED_USERS.admin);
    const seedOrg = await seedOrgId();

    // A salesperson can't hand out turns, even in their own org.
    expect((await rep.db.rpc("next_rotation_assignee", { p_org: seedOrg })).error).not.toBeNull();
    // An admin can't reach into another org.
    expect((await seedAdmin.db.rpc("next_rotation_assignee", { p_org: org.orgId })).error).not.toBeNull();
    // Anonymous callers can't call it at all.
    expect((await anonClient().rpc("next_rotation_assignee", { p_org: org.orgId })).error).not.toBeNull();
  });

  it("keeps the rotation state unreadable to client roles", async () => {
    const orgAdmin = await sessionFor(org.adminEmail);
    const { data } = await orgAdmin.db.from("assignment_rotation").select("*");
    expect(data ?? []).toHaveLength(0);
  });
});
