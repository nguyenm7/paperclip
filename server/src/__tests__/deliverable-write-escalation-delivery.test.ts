import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  buildDeliverableWriteEscalationIdempotencyKey,
  scheduleDeliverableWriteEscalation,
} from "../services/recovery/deliverable-write-escalation.js";

// LOOA-347 (the LOOA-334/LOOA-335 class, found by the LOOA-344 caller sweep):
// the recovery_deliverable_write_escalation wake is enqueued for the SAME
// agent and SAME issue as the status-only recovery run that just got 403'd on
// a deliverable write — and that source run is RUNNING at that moment, because
// it is the run making the denied HTTP request. Without a fresh-run boundary
// the wake coalesced into the source run, whose process was spawned with its
// prompt before the merge and never re-reads the context column: the
// escalation instruction never rendered, the write was silently lost, the
// agent was explicitly told not to retry it, and the activity log claimed the
// escalation was scheduled.
//
// The contract this suite pins: while the source run is live, the escalation
// wake is PARKED as deferred_issue_execution (never merged into the live run),
// scheduleDeliverableWriteEscalation still reports "scheduled" (enqueueWakeup
// returns null for deferred — the ledger row is the receipt), and when the
// source run exits, releaseIssueExecutionAndPromote promotes the deferred wake
// into a run of its own that carries the escalation instruction.
//
// A stubbed wakeup cannot catch any of this — the defect lives at the seam
// with the real heartbeat service, so the tests drive the real one (same
// harness shape as wake-delivery-reporting.test.ts).

const INSTRUCTION_MARKER = "was denied a deliverable write";

const mockAdapterExecute = vi.fn(async () => ({
  ok: true,
  output: "",
  model: "test-model",
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping deliverable write escalation delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("deliverable write escalation survives a live source run (LOOA-347)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deliverable-escalation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedIssueWithLiveStatusOnlyRun(options: { stampExecutionRunId: boolean }) {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      status: "active",
    });

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Recovery Agent",
      role: "cto",
      status: "idle",
    });

    const issueId = randomUUID();
    const sourceRunId = randomUUID();

    // The cheap status-only recovery run, exactly as it exists at the moment
    // it makes the denied deliverable-write request: RUNNING, tracked in
    // runningProcesses (a genuinely live process, not a zombie), context
    // carrying the status-only hints and the issueId. Inserted before the
    // issue so the issue's executionRunId FK can point at it.
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        wakeReason: "issue_execution_recovery",
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
      startedAt: new Date(),
    });
    runningProcesses.set(sourceRunId, {
      child: { pid: 1234 } as never,
      graceSec: 5,
      processGroupId: null,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue whose next action is a deliverable write",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      ...(options.stampExecutionRunId
        ? {
            executionRunId: sourceRunId,
            executionAgentNameKey: "recovery agent",
            executionLockedAt: new Date(),
          }
        : {}),
    });

    return { companyId, agentId, issueId, sourceRunId };
  }

  function scheduleEscalation(seed: {
    companyId: string;
    agentId: string;
    issueId: string;
    sourceRunId: string;
  }) {
    return scheduleDeliverableWriteEscalation(db, heartbeat.wakeup, {
      companyId: seed.companyId,
      issueId: seed.issueId,
      agentId: seed.agentId,
      sourceRunId: seed.sourceRunId,
      deniedMutation: {
        method: "PUT",
        path: `/api/issues/${seed.issueId}/documents/findings`,
      },
    });
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function runsCarryingEscalationInstruction(agentId: string, excludeRunId: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return runs.filter((run) => {
      if (run.id === excludeRunId) return false;
      const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
      return String(context.deliverableWriteEscalationInstruction ?? "").includes(INSTRUCTION_MARKER);
    });
  }

  it("parks the escalation as a deferred wake while the source run is live, then promotes it into a run of its own when the source run exits", async () => {
    const seed = await seedIssueWithLiveStatusOnlyRun({ stampExecutionRunId: true });
    const idempotencyKey = buildDeliverableWriteEscalationIdempotencyKey({
      issueId: seed.issueId,
      sourceRunId: seed.sourceRunId,
    });

    const result = await scheduleEscalation(seed);
    expect(result.outcome).toBe("scheduled");

    // The escalation must NOT have been coalesced into the live source run —
    // that process was spawned with its prompt before any merge and never
    // re-reads the context column, so a merge means the instruction is lost.
    const sourceRun = await readRun(seed.sourceRunId);
    const sourceContext = (sourceRun?.contextSnapshot ?? {}) as Record<string, unknown>;
    expect(
      sourceContext.deliverableWriteEscalationInstruction,
      "the escalation instruction must not be merged into the running source run — a merged prompt never renders",
    ).toBeUndefined();

    const ledgerRow = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seed.companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(ledgerRow, "the escalation must leave a ledger row under its idempotency key").toBeTruthy();
    expect(
      ledgerRow!.status,
      "while the source run is live the escalation is parked for promotion, not coalesced away",
    ).toBe("deferred_issue_execution");

    // A retry of the same denied write from the same source run must not stack
    // a second escalation.
    const retry = await scheduleEscalation(seed);
    expect(retry.outcome).toBe("already_scheduled");

    // The source run reports status and exits (its process is gone before the
    // control plane finalizes the row, so no signal is sent). Finalization
    // must promote the deferred escalation into a run of its own.
    runningProcesses.delete(seed.sourceRunId);
    await heartbeat.cancelRun(seed.sourceRunId);

    const carriers = await runsCarryingEscalationInstruction(seed.agentId, seed.sourceRunId);
    expect(
      carriers.length,
      "after the source run exits, a run of its own must carry the escalation instruction so it actually renders",
    ).toBeGreaterThan(0);
    expect(
      (carriers[0]!.contextSnapshot as Record<string, unknown>).forceFreshSession,
      "the promoted escalation run starts a fresh session — it must not resume the status-only transcript",
    ).toBe(true);
  }, 30_000);

  it("defers instead of coalescing when the source run holds the issue only via the legacy contextSnapshot issueId fallback", async () => {
    const seed = await seedIssueWithLiveStatusOnlyRun({ stampExecutionRunId: false });
    const idempotencyKey = buildDeliverableWriteEscalationIdempotencyKey({
      issueId: seed.issueId,
      sourceRunId: seed.sourceRunId,
    });

    const result = await scheduleEscalation(seed);
    expect(result.outcome).toBe("scheduled");

    const sourceRun = await readRun(seed.sourceRunId);
    const sourceContext = (sourceRun?.contextSnapshot ?? {}) as Record<string, unknown>;
    expect(
      sourceContext.deliverableWriteEscalationInstruction,
      "the legacy executionRunId-less lookup must defer too — both lookups reach the same coalesce branch",
    ).toBeUndefined();

    const ledgerRow = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seed.companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(ledgerRow?.status).toBe("deferred_issue_execution");
  }, 30_000);

  it("still reports scheduled when the escalation merges into a pre-existing deferred wake for the same issue, and dedupes retries through the merged context", async () => {
    const seed = await seedIssueWithLiveStatusOnlyRun({ stampExecutionRunId: true });

    // A comment follow-up that arrived mid-run and was parked. The escalation
    // will merge into this row, losing its own idempotencyKey — the merged
    // deferred context is then the only trace that the escalation is on board.
    await db.insert(agentWakeupRequests).values({
      companyId: seed.companyId,
      agentId: seed.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId: seed.issueId,
        _paperclipWakeContext: {
          issueId: seed.issueId,
          taskId: seed.issueId,
          wakeReason: "issue_commented",
        },
      },
      status: "deferred_issue_execution",
      idempotencyKey: "unrelated-comment-wake-key",
    });

    const result = await scheduleEscalation(seed);
    expect(
      result.outcome,
      "a merge into a deferred wake still delivers on promotion — the truthful outcome is scheduled",
    ).toBe("scheduled");

    const deferredRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, seed.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(deferredRows.length, "the escalation merges into the existing deferred wake, not a second row").toBe(1);
    const mergedContext = ((deferredRows[0]!.payload ?? {}) as Record<string, unknown>)
      ._paperclipWakeContext as Record<string, unknown>;
    expect(mergedContext.deliverableWriteEscalationSourceRunId).toBe(seed.sourceRunId);
    expect(String(mergedContext.deliverableWriteEscalationInstruction ?? "")).toContain(INSTRUCTION_MARKER);

    const retry = await scheduleEscalation(seed);
    expect(
      retry.outcome,
      "retries must recognize the escalation inside the merged deferred context even though its idempotencyKey was dropped",
    ).toBe("already_scheduled");
  }, 30_000);
});
