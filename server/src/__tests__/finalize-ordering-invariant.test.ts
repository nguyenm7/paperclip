import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY } from "../services/recovery/index.ts";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// LOOA-376 (follow-up to the LOOA-349 delivery gates; blocked on it until now).
//
// LOOA-349 added two gates in the post-run finalize path that skip a persisted
// marker when a continuation/handoff wake was swallowed by an already-running
// run (`delivered === "merged_running"`):
//
//   - handleRunLivenessContinuation  — skip the `continuationAttempt` stamp.
//   - handleSuccessfulRunHandoff     — skip the raise-once handoff comment and
//                                      its `issue.successful_run_handoff_required`
//                                      audit row.
//
// Both gates run at the finalize call site, after the run has been persisted to
// a terminal status and after `releaseIssueExecutionAndPromote(livenessRun)`:
//
//     let persistedRun = await setRunStatus(run.id, status, {...});  // -> succeeded
//     ...
//     await releaseIssueExecutionAndPromote(livenessRun);   // frees the lock
//     await handleRunLivenessContinuation(livenessRun);     // then wakes
//     await handleSuccessfulRunHandoff(livenessRun, agent);
//
// Why `delivered === "merged_running"` is unreachable here (verified in the
// LOOA-349 review, and re-derived building this test): a wake only reports
// `merged_running` when it COALESCES into a same-scope run that is live —
// `activeExecutionRun` must have an execution-path status
// (`queued`/`running`/`scheduled_retry`) and, if `running`, be tracked in the
// live-process registry, or `isZombieRun` filters it out. By this call site the
// finished run is already `succeeded` (setRunStatus fired far above), so it is
// no longer an execution-path status and can never be the coalesce target; and
// `releaseIssueExecutionAndPromote` leaves any promoted run `queued`, which
// reports `merged_queued`. So the guard clauses cannot be hit today, and a
// direct regression test on the guard body is impossible.
//
// The gates are defensive against a FUTURE finalize-path change that lets a
// continuation/handoff wake coalesce into a live same-scope run — e.g. moving a
// wake above the terminal-status flip while the run is still `running` and
// tracked, or promoting a run to `running` rather than leaving it `queued`. Then
// the wake reports `merged_running`, the gate fires, and the marker is silently
// dropped into an error log nobody reads.
//
// So, per the LOOA-349 review guidance ("assert the invariant, not the
// mechanism"), these tests do not exercise the unreachable guard body. They
// drive a REAL run through the finalize path and pin the OUTCOME the invariant
// guarantees — that the wake was delivered and its marker written:
//
//   1. the wake produced its own distinct run that renders (not a merge into the
//      still-live source), i.e. `delivered !== "merged_running"`; AND
//   2. the persisted marker the gate suppresses on a swallowed wake was actually
//      written (`continuationAttempt` stamp / handoff comment + audit row).
//
// This passes today and fails LOUDLY if any future finalize-path change lets the
// wake be swallowed (`merged_running`): the gate then fires and the marker this
// test asserts on vanishes. That failure mode was confirmed while writing this
// test — forcing either gate to fire drops the stamp / the handoff comment and
// both assertions below fail.
//
// Harness note (load-bearing, from the LOOA-349 review): isolation is by
// IDENTITY, never by wiping shared state. `wakeup` awaits
// `startNextQueuedRunForAgent`, which fires a fire-and-forget `executeRun` whose
// writes (and, here, the bounded continuation cascade) outlive the test body. A
// `truncate ... cascade` would deadlock those in-flight writes and corrupt the
// next test. So every company gets a unique issue prefix, nothing truncates,
// every read is scoped to a fresh agent/issue id, and teardown waits for the
// database to go quiet.

// The adapter streams these stdout chunks via `onLog` before returning. Stdout
// is what the run-liveness classifier reads, so this is the lever that decides
// whether the finalized run lands in a continuation state (plan_only) or a
// productive-but-undisposed state (needs_followup) that triggers the handoff.
let adapterStdoutLines: string[] = [];
const mockAdapterExecute = vi.fn(async (opts: { onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void }) => {
  for (const line of adapterStdoutLines) {
    await opts.onLog?.("stdout", line);
  }
  return { ok: true, output: "", model: "test-model" };
});

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
    `Skipping finalize-ordering invariant tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("finalize path wakes AFTER releasing the execution lock (LOOA-376)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-finalize-ordering-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    // Drain the bounded continuation cascade (source -> attempt 1 -> attempt 2 ->
    // exhausted) before the next test flips `adapterStdoutLines`, so a late
    // background run cannot read the wrong stdout for someone else's scope.
    await waitForDatabaseQuiescence();
  });

  afterAll(async () => {
    runningProcesses.clear();
    await waitForDatabaseQuiescence();
    await tempDb?.cleanup();
  });

  /** Poll until no other backend is running a query against this database. */
  async function waitForDatabaseQuiescence(timeoutMs = 15_000) {
    const started = performance.now();
    let idleSamples = 0;
    while (performance.now() - started < timeoutMs) {
      const rows = (await db.execute(sql`
        select count(*)::int as active
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state <> 'idle'
      `)) as unknown as Array<{ active: number }>;
      if (Number(rows[0]?.active ?? 0) === 0) {
        idleSamples += 1;
        if (idleSamples >= 3) return;
      } else {
        idleSamples = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      status: "active",
      // Unique per company: the default prefix is shared, and with no truncate a
      // shared prefix is what turns any leftover row into a cross-test failure.
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Creator", role: "cto" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      // Title/description must NOT read as a planning/document task, or the
      // classifier exempts it from plan-only and the continuation never fires.
      title: "Ship the widget",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  /**
   * Wake the idle assignee on its issue (a real new run), then block until the
   * fire-and-forget `executeRun` has driven it through finalize. Returns the
   * source run id so assertions can scope strictly to it.
   */
  async function driveRunToFinalize(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, prompt: "Please continue the work." },
      contextSnapshot: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(run, "the idle assignee should get a real new run to finalize").toBeTruthy();
    const sourceRunId = run!.id;
    await waitUntil(async () => {
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
      return row?.status === "succeeded" || row?.status === "failed";
    }, 25_000);
    return sourceRunId;
  }

  async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  it("liveness continuation: the finalized run stamps continuationAttempt and the wake gets its own run — never merged_running", async () => {
    // A planning-only stdout ("Next steps: … inspect … run the tests") lands the
    // finalized run in the `plan_only` liveness state, which is exactly one of
    // the two states handleRunLivenessContinuation acts on.
    adapterStdoutLines = ["Next steps: I will inspect the logs and run the tests to verify the fix.\n"];
    const { agentId, issueId } = await seedCompanyAgentIssue();
    const sourceRunId = await driveRunToFinalize(agentId, issueId);

    // The stamp is written at the very end of the finalize path, after the
    // status flips to succeeded. Wait for the invariant's observable outcome
    // rather than a fixed sleep — if the ordering were violated the stamp would
    // never appear and this poll would fall through to a failing assertion.
    await waitUntil(async () => {
      const [row] = await db
        .select({ continuationAttempt: heartbeatRuns.continuationAttempt })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, sourceRunId));
      return Number(row?.continuationAttempt ?? 0) >= 1;
    }, 15_000);

    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    const runsForAgent = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const continuationRun = runsForAgent.find(
      (candidate) =>
        (candidate.contextSnapshot as Record<string, unknown> | null)?.livenessContinuationSourceRunId === sourceRunId,
    );

    // Precondition: the continuation path was genuinely exercised. If a future
    // classifier change moves this run out of the actionable states, this fails
    // loudly (setup drift) instead of passing vacuously.
    expect(source!.status, "the driven run must finalize as succeeded").toBe("succeeded");
    expect(
      source!.livenessState,
      "the run must land in a state handleRunLivenessContinuation acts on, or the gate under test is never reached",
    ).toBe("plan_only");

    // INVARIANT #1 — the wake was delivered, not swallowed. A merged_running
    // wake would have coalesced INTO the still-live source run; instead the
    // continuation got a distinct run of its own that will render.
    expect(
      continuationRun,
      "the continuation wake must produce its own run (delivered new_run/merged_queued), not merge into the finished source",
    ).toBeTruthy();
    expect(
      continuationRun!.id,
      "a distinct run id proves the wake did not coalesce into the still-running source run (which is what merged_running means)",
    ).not.toBe(sourceRunId);

    // INVARIANT #2 — the marker the gate suppresses on a swallowed wake was
    // actually written. This is the tripwire: if a finalize-path change ever
    // lets this wake report merged_running, the gate fires and this stamp stays
    // 0 (confirmed by forcing the gate while writing this test).
    expect(
      Number(source!.continuationAttempt),
      "continuationAttempt must be stamped; the gate would drop this stamp if the wake reported merged_running",
    ).toBe(1);
  }, 60_000);

  it("successful-run handoff: the finalized run posts the raise-once comment and audit row — never merged_running", async () => {
    // No adapter stdout: the run succeeds with only the system's fallback-
    // workspace notice as output, which classifies as `needs_followup` — a
    // productive state with no valid disposition, and crucially NOT a
    // continuation state (so no continuation wake is queued to pre-empt the
    // handoff). That is exactly the shape handleSuccessfulRunHandoff acts on.
    adapterStdoutLines = [];
    const { agentId, issueId } = await seedCompanyAgentIssue();
    const sourceRunId = await driveRunToFinalize(agentId, issueId);

    await waitUntil(async () => {
      const rows = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      return rows.some((row) => row.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    }, 15_000);

    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const auditRows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));

    // Precondition: the handoff path was genuinely exercised.
    expect(source!.status, "the driven run must finalize as succeeded").toBe("succeeded");
    expect(
      ["advanced", "completed", "blocked", "needs_followup"],
      "the run must be a productive success with no disposition, or handleSuccessfulRunHandoff skips before the gate",
    ).toContain(source!.livenessState);

    // INVARIANT — the two side effects the handoff gate suppresses on a
    // swallowed wake are both present: the raise-once comment and the audit row
    // asserting a corrective run. If a finalize-path change ever lets this wake
    // report merged_running, the gate fires and both vanish (confirmed by
    // forcing the gate while writing this test).
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(
      handoffComment,
      "the raise-once handoff comment must be posted; the gate would skip it if the wake reported merged_running",
    ).toBeTruthy();
    expect(
      handoffComment!.createdByRunId,
      "the handoff comment must be attributed to the finalized source run",
    ).toBe(sourceRunId);

    const handoffAudit = auditRows.find((row) => row.action === "issue.successful_run_handoff_required");
    expect(
      handoffAudit,
      "the successful-run-handoff audit row must be written; the gate would skip it if the wake reported merged_running",
    ).toBeTruthy();
    expect(
      (handoffAudit!.details as Record<string, unknown>).sourceRunId,
      "the audit row must record the finalized source run as the origin of the handoff",
    ).toBe(sourceRunId);
  }, 60_000);
});
