import { describe, expect, it, vi } from "vitest";
import { checkStageMove, statusForStage } from "@/lib/domain/opportunity";
import { isAssignmentMode, manualAssignment, roundRobinAssignment } from "@/lib/domain/assignment";

describe("statusForStage", () => {
  it("derives status from stage flags, not labels", () => {
    expect(statusForStage({ is_won: true, is_lost: false })).toBe("won");
    expect(statusForStage({ is_won: false, is_lost: true })).toBe("lost");
    expect(statusForStage({ is_won: false, is_lost: false })).toBe("open");
  });
});

describe("checkStageMove", () => {
  const open = { is_won: false, is_lost: false };
  const won = { is_won: true, is_lost: false };
  const lost = { is_won: false, is_lost: true };

  it("allows moves to open and won stages and clears any old lost reason", () => {
    expect(checkStageMove(open, "stale reason")).toEqual({ ok: true, lostReason: null });
    expect(checkStageMove(won)).toEqual({ ok: true, lostReason: null });
  });

  it("requires a reason to mark a lead lost", () => {
    expect(checkStageMove(lost).ok).toBe(false);
    expect(checkStageMove(lost, "   ").ok).toBe(false);
  });

  it("keeps a trimmed lost reason", () => {
    expect(checkStageMove(lost, "  Price too high ")).toEqual({ ok: true, lostReason: "Price too high" });
  });
});

describe("manualAssignment", () => {
  it("honours the requested assignee and otherwise leaves the lead unassigned", async () => {
    const base = { orgId: "o", source: "manual" };
    expect(await manualAssignment.pickAssignee({ ...base, requestedAssigneeId: "rep-a" })).toBe("rep-a");
    expect(await manualAssignment.pickAssignee({ ...base, requestedAssigneeId: null })).toBeNull();
  });
});

describe("roundRobinAssignment", () => {
  const base = { orgId: "org-1", source: "meta" };

  it("takes the next turn when nobody was chosen", async () => {
    const turns = ["rep-a", "rep-b"];
    const next = vi.fn(async () => turns.shift() ?? null);
    const strategy = roundRobinAssignment(next);

    expect(await strategy.pickAssignee({ ...base, requestedAssigneeId: null })).toBe("rep-a");
    expect(await strategy.pickAssignee({ ...base, requestedAssigneeId: null })).toBe("rep-b");
    expect(next).toHaveBeenCalledWith("org-1");
  });

  it("lets an explicit choice win without using up anyone's turn", async () => {
    const next = vi.fn(async () => "rep-a");
    expect(await roundRobinAssignment(next).pickAssignee({ ...base, requestedAssigneeId: "rep-z" })).toBe("rep-z");
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves the lead unassigned when the rotation is empty", async () => {
    expect(await roundRobinAssignment(async () => null).pickAssignee({ ...base, requestedAssigneeId: null })).toBeNull();
  });
});

describe("isAssignmentMode", () => {
  it("accepts only the known modes", () => {
    expect(isAssignmentMode("manual")).toBe(true);
    expect(isAssignmentMode("round_robin")).toBe(true);
    expect(isAssignmentMode("load_based")).toBe(false);
    expect(isAssignmentMode(undefined)).toBe(false);
  });
});
