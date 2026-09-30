/**
 * The seam where automatic routing plugs in. Manual assignment is the default;
 * round-robin is the first automatic strategy. New ones (load-based, by
 * source) are added as further implementations of this interface, not as
 * branches in `captureLead`.
 */

export interface AssignmentContext {
  orgId: string;
  /** Where the lead came from (`meta`, `manual`, `mock`…), so strategies can route by source. */
  source: string;
  /** An assignee chosen explicitly by a person or by an integration's default-assignee setting. */
  requestedAssigneeId: string | null;
}

export interface AssignmentStrategy {
  readonly name: AssignmentMode;
  /** How the timeline describes an assignment this strategy made on its own. */
  readonly label: string;
  /** The user id to assign to, or null to leave the lead unassigned. */
  pickAssignee(context: AssignmentContext): Promise<string | null>;
}

export const ASSIGNMENT_MODES = ["manual", "round_robin"] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export function isAssignmentMode(value: unknown): value is AssignmentMode {
  return typeof value === "string" && (ASSIGNMENT_MODES as readonly string[]).includes(value);
}

/** Honour whoever was explicitly chosen, otherwise leave unassigned. */
export const manualAssignment: AssignmentStrategy = {
  name: "manual",
  label: "manual",
  async pickAssignee(context) {
    return context.requestedAssigneeId;
  },
};

/**
 * An explicit choice (a person picking an assignee, an integration's default
 * assignee) still wins; otherwise the next member in the org's rotation gets
 * the lead. Taking the turn is I/O (it must be atomic across concurrent
 * deliveries), so the caller supplies it.
 */
export function roundRobinAssignment(nextInRotation: (orgId: string) => Promise<string | null>): AssignmentStrategy {
  return {
    name: "round_robin",
    label: "round-robin",
    async pickAssignee(context) {
      return context.requestedAssigneeId ?? nextInRotation(context.orgId);
    },
  };
}
