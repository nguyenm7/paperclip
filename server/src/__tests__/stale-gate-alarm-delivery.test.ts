import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { staleGateDetectorService } from "../services/stale-gate-detector.ts";

// LOOA-334 (security review of LOOA-296): the stale-gate detector treats a
// truthy return from heartbeat.wakeup as proof the alarm was delivered, and
// only then stamps stale_premise_alarmed_at (raise-once).
//
// But the alarm wake carries no issueId and no taskKey, so it shares the null
// task scope with the CEO's ordinary runs. When the CEO already has a LIVE
// (tracked, non-zombie) run in that scope, enqueueWakeup takes the coalesce
// branch: it merges the alarm prompt into the running run's contextSnapshot
// and returns that run. The run's adapter process was already spawned with its
// prompt, so the merged wakeMessage is never rendered — yet the detector sees
// a run ref, stamps raise-once, and writes an "alarmed" audit row naming the
// coalesced run id. The alarm is silenced forever and the ledger says it fired.
//
// heartbeat.ts already has the guard for this hazard —
// RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP — which forces a NEW queued run
// instead of coalescing into a live one. "stale_gate_alarm" is not on that list.
//
// The invariant this test pins: a sweep must never stamp raise-once unless the
// alarm got a run that will actually render it.

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
    `Skipping stale-gate alarm delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stale-gate alarm delivery vs. wake coalescing (LOOA-334)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-gate-delivery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    // heartbeat_runs <-> agent_wakeup_requests reference each other, so drop the
    // whole graph in one cascade rather than ordering deletes.
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  function makeDetector() {
    return staleGateDetectorService(db as any, {
      wakeup: ((agentId: string, opts: any) => heartbeat.wakeup(agentId, opts)) as any,
    });
  }

  /** A pending board approval whose only source issue is already `done`. */
  async function seedStaleCard() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", status: "active" });

    const ceoId = randomUUID();
    const creatorId = randomUUID();
    await db.insert(agents).values([
      { id: ceoId, companyId, name: "CEO", role: "ceo" },
      { id: creatorId, companyId, name: "CTO", role: "cto" },
    ]);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the Signal Aggregator",
      status: "done",
      identifier: "LOOA-4",
    });

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: creatorId,
      status: "pending",
      payload: { title: "Approve Signal Aggregator build + spend envelope" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    return { companyId, ceoId, approvalId };
  }

  /**
   * A genuinely live run for the CEO in the null task scope (no issueId in the
   * context snapshot) — e.g. an ordinary timer heartbeat that is mid-flight
   * when the hourly sweep fires. Registering it in `runningProcesses` is what
   * makes it a real live run rather than a zombie, which is the state the
   * server is in whenever the CEO happens to be working.
   */
  async function seedLiveCeoRun(companyId: string, ceoId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: ceoId,
      invocationSource: "timer",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(),
    });
    runningProcesses.set(runId, {
      child: { pid: 1234 } as never,
      graceSec: 5,
      processGroupId: null,
    });
    return runId;
  }

  /**
   * Any run that actually carries the alarm prompt as its own wake message.
   * The run may already have advanced past `queued` (enqueueWakeup kicks
   * startNextQueuedRunForAgent), so status is not part of the predicate — what
   * matters is that the alarm got a run of its OWN, distinct from a run that
   * was already live before the alarm existed.
   */
  async function runsCarryingTheAlarm(ceoId: string, excludeRunId: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ceoId));
    return runs.filter(
      (run) =>
        run.id !== excludeRunId &&
        String((run.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? "").includes(
          "Stale-gate alarm",
        ),
    );
  }

  it("raise-once is only stamped when the alarm got its own run — a wake coalesced into the CEO's already-live run must not count as delivered", async () => {
    const { companyId, ceoId, approvalId } = await seedStaleCard();
    const liveRunId = await seedLiveCeoRun(companyId, ceoId);

    const detector = makeDetector();
    const result = await detector.sweep();

    expect(result.flagged).toBe(1);

    const [card] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const alarmRuns = await runsCarryingTheAlarm(ceoId, liveRunId);

    if (card!.stalePremiseAlarmedAt) {
      // Raise-once was burned, so the alarm must have a run that will actually
      // render it. Merging the prompt into the already-running run does not
      // count: that adapter process was spawned with its prompt before the
      // merge and never re-reads contextSnapshot.
      expect(
        alarmRuns.length,
        "raise-once was stamped but no run carries the alarm — it was coalesced into the CEO's already-live run, whose process will never render the merged wakeMessage. The card is now permanently silenced and the activity log claims it was alarmed.",
      ).toBeGreaterThan(0);
    } else {
      // The failure-closed alternative the detector documents: leave the card
      // unstamped so the next sweep retries delivery.
      expect(result.alarmed).toBe(0);
      expect(result.wakesFailed).toBeGreaterThan(0);
    }
  }, 30_000);

  it("the alarm still reaches the CEO when they are mid-run (it gets a follow-up run, not a merge into the live one)", async () => {
    const { companyId, ceoId } = await seedStaleCard();
    const liveRunId = await seedLiveCeoRun(companyId, ceoId);

    const detector = makeDetector();
    await detector.sweep();

    const alarmRuns = await runsCarryingTheAlarm(ceoId, liveRunId);
    expect(
      alarmRuns.length,
      "the CEO having a live run must not swallow the alarm — the wake needs its own follow-up run",
    ).toBeGreaterThan(0);
  }, 30_000);
});
