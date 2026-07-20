import { describe, expect, it } from "vitest";
import { eventTypeForActivityAction } from "./activity-log.js";

/**
 * LOOA-323 regression: every terminal issue-interaction transition must map
 * to a plugin event. `issue.thread_interaction_withdrawn` (LOOA-294) was
 * missing from the map, so a withdrawal emitted NO `issue.interaction.resolved`
 * event — the gateway's event-targeted card heal never fired and a withdrawn
 * card kept live buttons until the reconcile interval (measured 2m39s, longer
 * than the board's 79s reaction time). Same gap for `approval.withdrawn`.
 */
describe("activity action → plugin event mapping", () => {
  it("maps every terminal interaction transition to issue.interaction.resolved", () => {
    for (const terminal of ["accepted", "rejected", "answered", "cancelled", "expired", "withdrawn"]) {
      expect(eventTypeForActivityAction(`issue.thread_interaction_${terminal}`)).toBe(
        "issue.interaction.resolved",
      );
    }
  });

  it("maps every terminal approval transition to approval.decided", () => {
    for (const terminal of ["approved", "rejected", "revision_requested", "withdrawn"]) {
      expect(eventTypeForActivityAction(`approval.${terminal}`)).toBe("approval.decided");
    }
  });

  it("passes through first-class plugin event types and drops unknown actions", () => {
    expect(eventTypeForActivityAction("issue.interaction.resolved")).toBe("issue.interaction.resolved");
    expect(eventTypeForActivityAction("issue.some_internal_action")).toBeNull();
  });
});
