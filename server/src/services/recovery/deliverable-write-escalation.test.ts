import { describe, expect, it, vi } from "vitest";
import {
  DELIVERABLE_WRITE_ESCALATION_PATH,
  DELIVERABLE_WRITE_ESCALATION_REASON,
  buildDeliverableWriteEscalationIdempotencyKey,
  buildDeliverableWriteEscalationWake,
  scheduleDeliverableWriteEscalation,
} from "./deliverable-write-escalation.js";

const deniedMutation = { method: "PUT", path: "/api/issues/issue-1/documents/findings" };

// Each element is the row set served to the next wake-ledger probe; once the
// queue drains, further probes see an empty ledger. Two probes can run per
// schedule call: the dedup pre-check and the post-null deferred-row re-probe.
function createDb(...wakeRowResponses: unknown[][]) {
  const responseQueue = [...wakeRowResponses];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve(responseQueue.shift() ?? []),
          })),
        })),
      })),
    })),
  } as never;
}

describe("deliverable write escalation", () => {
  it("keys idempotency by issue and source run so each recovery run escalates at most once", () => {
    expect(buildDeliverableWriteEscalationIdempotencyKey({
      issueId: "issue-1",
      sourceRunId: "run-1",
    })).toBe("recovery_deliverable_write_escalation:issue-1:run-1");
  });

  it("builds a normal-model wake with all cheap status-only hints scrubbed", () => {
    const wake = buildDeliverableWriteEscalationWake({
      issueId: "issue-1",
      sourceRunId: "run-1",
      deniedMutation,
    });

    expect(wake.reason).toBe(DELIVERABLE_WRITE_ESCALATION_REASON);
    for (const snapshot of [wake.payload, wake.contextSnapshot] as Record<string, unknown>[]) {
      expect(snapshot.modelProfile).toBeUndefined();
      expect(snapshot.recoveryIntent).toBeUndefined();
      expect(snapshot.allowDeliverableWork).toBeUndefined();
      expect(snapshot.allowDocumentUpdates).toBeUndefined();
      expect(snapshot.resumeRequiresNormalModel).toBeUndefined();
      expect(snapshot.issueId).toBe("issue-1");
    }
    expect(wake.payload.instruction).toContain("PUT /api/issues/issue-1/documents/findings");
    expect(wake.contextSnapshot.wakeReason).toBe(DELIVERABLE_WRITE_ESCALATION_REASON);
    // The source run is live when this wake fires (it is the run making the
    // denied request); forceFreshSession is what keeps the wake from
    // coalescing into it and evaporating (LOOA-347).
    expect(wake.contextSnapshot.forceFreshSession).toBe(true);
  });

  it("schedules exactly one wake for the denied write", async () => {
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-run-1" }));

    const result = await scheduleDeliverableWriteEscalation(createDb([]), enqueueWakeup, {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sourceRunId: "run-1",
      deniedMutation,
    });

    expect(result.outcome).toBe("scheduled");
    expect(result.escalationPath).toBe(DELIVERABLE_WRITE_ESCALATION_PATH);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "automation",
      reason: DELIVERABLE_WRITE_ESCALATION_REASON,
      idempotencyKey: "recovery_deliverable_write_escalation:issue-1:run-1",
      requestedByActorType: "system",
    }));
  });

  it("dedupes against an existing wake for the same source run", async () => {
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-run-1" }));

    const result = await scheduleDeliverableWriteEscalation(
      createDb([{ id: "wake-1", status: "queued" }]),
      enqueueWakeup,
      {
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        sourceRunId: "run-1",
        deniedMutation,
      },
    );

    expect(result.outcome).toBe("already_scheduled");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reports skipped when the wake is suppressed and failed when enqueueing throws", async () => {
    const skipped = await scheduleDeliverableWriteEscalation(createDb([]), vi.fn(async () => null), {
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      sourceRunId: "run-1",
      deniedMutation,
    });
    expect(skipped.outcome).toBe("skipped");

    const failed = await scheduleDeliverableWriteEscalation(
      createDb([]),
      vi.fn(async () => {
        throw new Error("wake enqueue exploded");
      }),
      {
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        sourceRunId: "run-1",
        deniedMutation,
      },
    );
    expect(failed.outcome).toBe("failed");
  });

  it("maps a deferred wake to scheduled: null return plus a ledger row parked for promotion", async () => {
    // While the denied source run is still live, enqueueWakeup defers the wake
    // (forceFreshSession) and returns null — the deferred_issue_execution row
    // is the delivery receipt, promoted to a real run when the source run exits.
    const enqueueWakeup = vi.fn(async () => null);

    const result = await scheduleDeliverableWriteEscalation(
      createDb([], [{ id: "wake-1", status: "deferred_issue_execution" }]),
      enqueueWakeup,
      {
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        sourceRunId: "run-1",
        deniedMutation,
      },
    );

    expect(result.outcome).toBe("scheduled");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("never reports a wake that merged into an already-running process as scheduled", async () => {
    // LOOA-334 class: a truthy run ref with delivered=merged_running means the
    // prompt landed in a process that will never render it.
    const result = await scheduleDeliverableWriteEscalation(
      createDb([]),
      vi.fn(async () => ({ id: "run-live", coalesced: true, delivered: "merged_running" })),
      {
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        sourceRunId: "run-1",
        deniedMutation,
      },
    );

    expect(result.outcome).toBe("failed");
  });

  it("treats merged_queued as scheduled — a queued run renders the merged wakeMessage when it starts", async () => {
    const result = await scheduleDeliverableWriteEscalation(
      createDb([]),
      vi.fn(async () => ({ id: "run-queued", coalesced: true, delivered: "merged_queued" })),
      {
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        sourceRunId: "run-1",
        deniedMutation,
      },
    );

    expect(result.outcome).toBe("scheduled");
  });
});
