import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService, wakeDeliveryForMergedRun } from "../services/heartbeat.ts";
import { buildHostServices } from "../services/plugin-host-services.ts";

// LOOA-342 (class fix behind LOOA-334 and LOOA-335): heartbeat.wakeup used to
// return a bare truthy run for a wake that was COALESCED into an
// already-running run — a run whose adapter process was spawned with its
// prompt before the merge and never re-reads the context column. The caller
// could not distinguish "new run carrying my prompt" from "prompt
// evaporated"; two shipped sweeps stamped raise-once markers on the truthy
// ref and wrote audit rows claiming an alarm fired that no agent ever saw.
//
// The old guard was RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP — a
// per-reason allow-list that forced a follow-up run for enrolled reason
// strings. Fixing one sweep did not fix the next: every new automation
// re-inherited the bug unless its author knew to enroll its reason.
//
// The contract this suite pins instead: the RETURN VALUE tells the truth.
// wakeup/invoke return `{ ...run, coalesced, delivered }` where delivered is
//   - "new_run"        — the wake got a run of its own; prompt renders at start
//   - "merged_queued"  — coalesced into a queued/scheduled_retry run that has
//                        not started; the merged wakeMessage renders at run
//                        start, so the wake still delivers
//   - "merged_running" — coalesced into a live run; THE PROMPT WILL NEVER BE
//                        SEEN. Callers persisting notified/raise-once markers
//                        gate on `delivered !== "merged_running"` and retry
//                        undelivered wakes on a later cycle.
// The allow-list survives only for the legacy `approval_approved` interrupt;
// nothing new should enroll there.
//
// The reason strings "aging_gate_rule11" / "aging_gate_rule11_escalation" are
// defined in the gateway repo (paperclip-gateway/src/aging.ts) and duplicated
// here as literals because the two repos share no package; the sweep there
// now gates its lastNudgedAt stamp on the delivered field this suite pins.
//
// A stubbed wakeup cannot catch any of this — the defect lives at the seam
// with the real heartbeat service, so the tests drive the real one.

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
    `Skipping wake delivery reporting tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wakeup reports coalescing truthfully (LOOA-342)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-delivery-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  /**
   * Isolation here is by IDENTITY, not by wiping shared state, and that is
   * load-bearing (LOOA-349 review). A wake to an agent with a free slot does
   * not just enqueue: `wakeup` awaits `startNextQueuedRunForAgent`, which
   * claims the queued run and fires `void executeRun(...)`. Those writes
   * (agent_runtime_state, heartbeat_runs, the post-run finalize path) outlive
   * the test body. A `truncate ... cascade` in afterEach takes an
   * AccessExclusiveLock against exactly those in-flight writes: under CPU
   * contention the two deadlock (Postgres 40P01), the truncate loses, the
   * company row survives, and the NEXT test dies on the
   * `companies_issue_prefix_idx` unique index — because every seeded company
   * defaulted to issue prefix "PAP". That is a flaky tripwire, which is worse
   * than no tripwire: it gets re-run until green and then stops being read.
   *
   * So: every company gets a unique issue prefix, no test truncates, and each
   * test's assertions are scoped to its own agent/issue ids. Background
   * executions from a previous test cannot collide with or mask the next one.
   */
  afterEach(() => {
    runningProcesses.clear();
  });

  afterAll(async () => {
    runningProcesses.clear();
    // Let any fire-and-forget executeRun finish its writes before the database
    // is torn down, so teardown does not race them into noisy FK errors.
    await waitForDatabaseQuiescence();
    await tempDb?.cleanup();
  });

  /** Poll until no other backend is running a query against this database. */
  async function waitForDatabaseQuiescence(timeoutMs = 10_000) {
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

  async function seedCompanyWithAgent(role: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      status: "active",
      // Unique per company: the default prefix is shared, and a shared prefix
      // is what turns any leftover row into a cross-test failure.
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Creator", role });
    return { companyId, agentId };
  }

  /**
   * A genuinely live run for the target agent in the null task scope (no
   * issueId in the context snapshot) — e.g. an ordinary timer heartbeat that
   * is mid-flight when an automation sweep fires. Registering it in
   * `runningProcesses` is what makes it a real live run rather than a zombie,
   * which is the state the server is in whenever that agent happens to be
   * working.
   */
  async function seedLiveRun(companyId: string, agentId: string, contextSnapshot: Record<string, unknown> = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      contextSnapshot,
      startedAt: new Date(),
    });
    runningProcesses.set(runId, {
      child: { pid: 1234 } as never,
      graceSec: 5,
      processGroupId: null,
    });
    return runId;
  }

  /** A queued run in the null task scope that has not started (no process). */
  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: {},
    });
    return runId;
  }

  /**
   * The wake exactly as the plugin bridge sends it for ctx.agents.invoke
   * (server/src/services/plugin-host-services.ts, `invoke`): automation
   * source, prompt-only payload, no issueId, no taskKey.
   */
  function invokeAsPluginBridge(agentId: string, reason: string, prompt: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { prompt },
      requestedByActorType: "system",
      requestedByActorId: "plugin:paperclip-gateway",
    });
  }

  async function runsCarryingThePrompt(agentId: string, excludeRunId: string, marker: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return runs.filter(
      (run) =>
        run.id !== excludeRunId &&
        String((run.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? "").includes(marker),
    );
  }

  it("a wake coalesced into a LIVE run reports coalesced=true delivered=merged_running — the caller can see the prompt evaporated", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const liveRunId = await seedLiveRun(companyId, agentId);

    const prompt = "Sweep alarm: your gate `abc12345` needs attention.";
    const run = await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", prompt);

    expect(run).toBeTruthy();
    expect(
      run!.id,
      "the wake should coalesce into the pre-existing live run — that is the hazard the flags exist to report",
    ).toBe(liveRunId);
    expect(run!.coalesced).toBe(true);
    expect(
      run!.delivered,
      "a merge into an already-running process must report merged_running: the process was spawned with its prompt before the merge and never re-reads the context column",
    ).toBe("merged_running");

    const carriers = await runsCarryingThePrompt(agentId, liveRunId, "Sweep alarm");
    expect(
      carriers.length,
      "no run of its own should carry the prompt — which is exactly why the return value must say so",
    ).toBe(0);
  }, 30_000);

  it("a wake coalesced into a QUEUED run reports delivered=merged_queued and the merged wakeMessage will render at run start", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const queuedRunId = await seedQueuedRun(companyId, agentId);

    const prompt = "Sweep alarm: your gate `def67890` needs attention.";
    const run = await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", prompt);

    expect(run).toBeTruthy();
    expect(run!.id).toBe(queuedRunId);
    expect(run!.coalesced).toBe(true);
    expect(
      run!.delivered,
      "a queued run has no process yet — the merged wakeMessage renders when it starts, so this wake still delivers",
    ).toBe("merged_queued");
    expect(
      String((run!.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? ""),
      "the merged run's context must carry the prompt so it renders at run start",
    ).toContain("Sweep alarm");
  }, 30_000);

  it("a wake to an idle agent reports coalesced=false delivered=new_run and the run carries the prompt", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");

    const prompt = "Sweep alarm: your gate `0a1b2c3d` needs attention.";
    const run = await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", prompt);

    expect(run).toBeTruthy();
    expect(run!.coalesced).toBe(false);
    expect(run!.delivered).toBe("new_run");
    expect(
      String((run!.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? ""),
    ).toContain("Sweep alarm");
  }, 30_000);

  it("the aging-gate sweep reasons are no longer force-followup enrolled — a mid-run creator wake reports merged_running instead, and the sweep retries next cycle", async () => {
    // Before LOOA-342 these two reasons lived on
    // RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP so a mid-run creator got a
    // follow-up run. The allow-list is retired as load-bearing: the sweep
    // (paperclip-gateway/src/aging.ts) now reads `delivered` and skips its
    // lastNudgedAt stamp on merged_running, retrying on the next hourly cycle.
    for (const reason of ["aging_gate_rule11", "aging_gate_rule11_escalation"]) {
      const { companyId, agentId } = await seedCompanyWithAgent("cto");
      const liveRunId = await seedLiveRun(companyId, agentId);

      const prompt = `Aging-gate sweep (${reason}): your gate has been pending 9 days.`;
      const run = await invokeAsPluginBridge(agentId, reason, prompt);

      expect(run).toBeTruthy();
      expect(run!.id, `reason ${reason} should coalesce like any other automation wake`).toBe(liveRunId);
      expect(run!.delivered, `reason ${reason} must report the swallowed prompt truthfully`).toBe("merged_running");

      // Each iteration seeds its own company + agent, so dropping the live run
      // from the process registry is the only cleanup needed between them.
      runningProcesses.clear();
    }
  }, 30_000);

  it("approval_approved keeps its legacy force-followup semantics: a mid-run requester still gets a run of its own", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const liveRunId = await seedLiveRun(companyId, agentId);

    const prompt = "Approval resolved: your hire request was approved.";
    const run = await invokeAsPluginBridge(agentId, "approval_approved", prompt);

    expect(run).toBeTruthy();
    expect(
      run!.id,
      "approval_approved is the one surviving allow-list entry — an approval resolution must interrupt as its own run",
    ).not.toBe(liveRunId);
    expect(run!.coalesced).toBe(false);
    expect(run!.delivered).toBe("new_run");

    const carriers = await runsCarryingThePrompt(agentId, liveRunId, "Approval resolved");
    expect(carriers.length).toBeGreaterThan(0);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // LOOA-344 F1 — the wakeMessage clobber on double-coalesce.
  //
  // `mergeCoalescedContextSnapshot` spread incoming over existing, so a SECOND
  // same-scope wake replaced the first wake's prompt on a run that had not
  // started yet. Both wakes were reported delivered (`merged_queued`, truthfully
  // at enqueue time) but only the last one ever rendered: the earlier report was
  // retroactively falsified. Any same-company plugin holding `agents.invoke`
  // could bury another caller's parked prompt this way.
  //
  // A `delivered` report the caller cannot trust is the same fail-open this
  // branch exists to close — it just moves from the return value to the column.
  // ---------------------------------------------------------------------------

  it("two wakes coalesced into the same QUEUED run both render — the second must not clobber the first's prompt (LOOA-344 F1)", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const queuedRunId = await seedQueuedRun(companyId, agentId);

    const first = await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", "Gate ALPHA needs attention.");
    const second = await invokeAsPluginBridge(agentId, "another_sweep_alarm", "Gate BRAVO needs attention.");

    // Both coalesce into the same parked carrier and both are reported delivered.
    expect(first!.id).toBe(queuedRunId);
    expect(second!.id).toBe(queuedRunId);
    expect(first!.delivered).toBe("merged_queued");
    expect(second!.delivered).toBe("merged_queued");

    const [carrier] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    const wakeMessage = String((carrier!.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? "");

    // The invariant: every wake reported delivered actually renders. If ALPHA is
    // gone, its `merged_queued` report was a lie.
    expect(
      wakeMessage,
      "the first wake was reported delivered (merged_queued) — its prompt must still be on the carrier that renders it",
    ).toContain("Gate ALPHA");
    expect(wakeMessage, "the second wake's prompt must render too").toContain("Gate BRAVO");
  }, 30_000);

  it("an idempotent re-wake with the same message does not duplicate it on the carrier (LOOA-344 F1)", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const queuedRunId = await seedQueuedRun(companyId, agentId);

    await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", "Gate ALPHA needs attention.");
    await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", "Gate ALPHA needs attention.");

    const [carrier] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));
    const wakeMessage = String((carrier!.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? "");

    expect(wakeMessage.match(/Gate ALPHA/g)?.length ?? 0).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // LOOA-378 — the cap must REFUSE, not EVICT.
  //
  // LOOA-344 F1's cap kept the buffer bounded by dropping the OLDEST prefix on
  // overflow. But eviction is a silent drop wearing a nice name: a wake that
  // coalesced onto a parked carrier and was truthfully reported `merged_queued`
  // could have its prompt pushed out of the 16KB buffer by a later flood before
  // the carrier ever started — retroactively falsifying its delivery report.
  // That is the F1 clobber resurrected at the truncation boundary.
  //
  // The fix makes the invariant total: on overflow we do NOT coalesce. The
  // incoming wake gets a fresh run of its own, so the buffer only ever grows
  // within its cap and no message reported delivered is ever evicted.
  //
  // This test asserts the invariant, not the mechanism — it re-fires for both
  // the clobber (F1) and the eviction (F2 of that class) rather than pinning the
  // truncation behaviour it replaces.
  // ---------------------------------------------------------------------------

  it("flooding a parked carrier past the cap queues fresh runs instead of evicting — every wake reported delivered still renders somewhere (LOOA-378)", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    await seedQueuedRun(companyId, agentId);
    // Keep every parked carrier from draining into `running` mid-flood: the
    // eviction bug lives on an UN-STARTED carrier, so the scenario must stay
    // deterministic. Cap the agent at one concurrent run and occupy that slot
    // with a live run in a DIFFERENT task scope (so it is never a coalesce
    // target for these null-scope invokes). `startNextQueuedRunForAgent` then
    // sees zero free slots and never claims a queued carrier — otherwise a
    // started carrier would honestly report `merged_running` (a different,
    // pre-existing "not delivered, retry" case) and race its own executeRun.
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, agentId));
    await seedLiveRun(companyId, agentId, { issueId: randomUUID() });

    // Flood a single parked carrier the way a looping/hostile plugin would:
    // enough ~2KB messages to blow well past the 16KB cap several times over.
    // Each carries a unique, findable marker.
    const reported: Array<{ marker: string; delivered: string }> = [];
    for (let i = 0; i < 40; i += 1) {
      const marker = `MSG-${String(i).padStart(3, "0")}`;
      const run = await invokeAsPluginBridge(
        agentId,
        "some_future_sweep_alarm",
        `${marker}: gate needs attention. ${"x".repeat(2_000)}`,
      );
      expect(run, `invoke ${marker} must return a carrier`).toBeTruthy();
      // Every wake here lands on a carrier that has not started: it either
      // coalesced onto a parked run (merged_queued) or, when coalescing would
      // have overflowed the cap, got a fresh queued run of its own (new_run).
      // Both are genuine delivery — the prompt renders at run start.
      expect(
        run!.delivered,
        `${marker} must be reported delivered on a not-yet-started carrier`,
      ).toMatch(/^(merged_queued|new_run)$/);
      reported.push({ marker, delivered: run!.delivered });
    }

    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const wakeMessageOf = (run: (typeof allRuns)[number]) =>
      String((run.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? "");
    // The occupying live run is a different scope and carries no flood marker.
    const carriers = allRuns.filter((run) => wakeMessageOf(run).includes("MSG-"));

    // The original LOOA-344 F1 concern still holds: no single contextSnapshot may
    // grow without bound. Refusing the coalesce keeps every carrier within the cap.
    for (const carrier of carriers) {
      expect(
        wakeMessageOf(carrier).length,
        "each carrier's accumulated wakeMessage must stay within the cap",
      ).toBeLessThanOrEqual(16_384);
    }

    // The LOOA-378 invariant: nothing reported delivered is ever evicted. Because
    // we refuse instead of drop, no truncation happens and every message reported
    // delivered is present on some carrier that will render it.
    const allWakeMessages = carriers.map(wakeMessageOf).join("\n");
    expect(
      allWakeMessages,
      "refusing to coalesce on overflow means nothing is evicted — the truncation marker must never appear",
    ).not.toContain("truncated");
    for (const { marker } of reported) {
      expect(
        allWakeMessages,
        `${marker} was reported delivered — its prompt must survive on some carrier, not be evicted at the cap`,
      ).toContain(marker);
    }

    // The flood must have spilled into fresh queued runs rather than piling onto
    // (and overflowing) the single seeded carrier.
    expect(
      carriers.length,
      "a flood past the cap must spill into fresh queued runs, not a single evicting buffer",
    ).toBeGreaterThan(1);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // LOOA-344 F2 — `delivered` was computed from a status read BEFORE the merge.
  //
  // The merge UPDATE matches on id only, while `claimQueuedRun` pins its own
  // UPDATE on `status = "queued"`. So a target could be claimed (queued ->
  // running) in the window between the pre-read and the merge: the spawned
  // process reads pre-merge context, the caller is told `merged_queued`, and the
  // gateway stamps a raise-once marker for a wake nobody will ever see.
  //
  // `delivered` now derives from the merge's own RETURNING row. The millisecond
  // interleaving itself has no injectable seam inside `wakeup` (a concurrent
  // test would be timing-dependent, and a flaky tripwire is worse than none), so
  // it is pinned two ways: the derivation function is tested directly against
  // every status, and an invariant test asserts the report always agrees with
  // the carrier's real state.
  // ---------------------------------------------------------------------------

  it("wakeDeliveryForMergedRun: only a run that has NOT started yet counts as delivered — terminal targets are NOT (LOOA-344 F2)", () => {
    // These re-fetch their context row when they start, so a merged prompt renders.
    expect(wakeDeliveryForMergedRun("queued")).toBe("merged_queued");
    expect(wakeDeliveryForMergedRun("scheduled_retry")).toBe("merged_queued");

    // Already read its context; will not re-read.
    expect(wakeDeliveryForMergedRun("running")).toBe("merged_running");

    // Will never read anything again. The OLD pre-read helper mapped every
    // non-"running" status to merged_queued, so a target that finished mid-merge
    // was reported DELIVERED and the caller stamped its raise-once marker.
    expect(wakeDeliveryForMergedRun("succeeded")).toBe("merged_running");
    expect(wakeDeliveryForMergedRun("failed")).toBe("merged_running");
    expect(wakeDeliveryForMergedRun("cancelled")).toBe("merged_running");

    // Fail closed on anything we do not recognise.
    expect(wakeDeliveryForMergedRun("some_future_status")).toBe("merged_running");
  });

  it("a merged_queued report always agrees with the carrier's real status — the report is never a stale pre-read (LOOA-344 F2)", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const queuedRunId = await seedQueuedRun(companyId, agentId);

    const run = await invokeAsPluginBridge(agentId, "some_future_sweep_alarm", "Gate CHARLIE needs attention.");
    expect(run!.id).toBe(queuedRunId);

    const [carrier] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId));

    // The invariant, stated so it re-fires if anyone reintroduces a pre-read:
    // delivered=merged_queued means "this carrier has not started and will render
    // the merged prompt". That must be true of the row as it actually stands.
    expect(run!.delivered).toBe("merged_queued");
    expect(
      wakeDeliveryForMergedRun(carrier!.status),
      "the report handed to the caller must match what the carrier's real status implies",
    ).toBe(run!.delivered);
  }, 30_000);
  // LOOA-349: the plugin bridge's issue-scoped wake routes
  // (`ctx.issues.requestWakeup` / `requestWakeups`) used to return only
  // `{ queued: Boolean(run), runId }` — `queued: true` for a swallowed
  // merged_running merge, indistinguishable from delivery. Any plugin that
  // persisted a notified-marker on `queued` re-inherited the LOOA-334 bug.
  // These tests pin the forwarded delivery report at the REAL bridge
  // (buildHostServices over the same live heartbeat service), not a stub.
  describe("plugin bridge requestWakeup(s) forward the delivery report (LOOA-349)", () => {
    function bridgeServices() {
      const eventBusStub = {
        forPlugin() {
          return { emit: async () => {}, subscribe: () => {} };
        },
      };
      return buildHostServices(db, "plugin-record-id", "paperclip.test-plugin", eventBusStub as never);
    }

    async function seedAssignedIssue(companyId: string, agentId: string, title: string) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      return issueId;
    }

    it("requestWakeup while the assignee is mid-run on the same issue reports queued=true BUT delivered=merged_running — queued is not a delivery receipt", async () => {
      const { companyId, agentId } = await seedCompanyWithAgent("cto");
      const issueId = await seedAssignedIssue(companyId, agentId, "Issue with a live run");
      const liveRunId = await seedLiveRun(companyId, agentId, { issueId });

      const result = await bridgeServices().issues.requestWakeup({
        issueId,
        companyId,
        reason: "some_future_plugin_sweep",
      });

      expect(
        result,
        "the exact wire shape plugin callers see: queued stays true for backward compatibility, but coalesced/delivered tell the truth",
      ).toEqual({
        queued: true,
        runId: liveRunId,
        coalesced: true,
        delivered: "merged_running",
      });

      const auditRows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      const wakeupRow = auditRows.find((row) => row.action === "issue.assignment_wakeup_requested");
      expect(wakeupRow, "the bridge writes an audit row for the wakeup request").toBeTruthy();
      expect(
        (wakeupRow!.details as Record<string, unknown>).delivered,
        "the audit row must record the delivery truth, not just a truthy runId",
      ).toBe("merged_running");
    }, 30_000);

    it("requestWakeup to an idle assignee reports coalesced=false delivered=new_run", async () => {
      const { companyId, agentId } = await seedCompanyWithAgent("cto");
      const issueId = await seedAssignedIssue(companyId, agentId, "Idle assignee issue");

      const result = await bridgeServices().issues.requestWakeup({
        issueId,
        companyId,
        reason: "some_future_plugin_sweep",
      });

      expect(result.queued).toBe(true);
      expect(result.runId).toBeTruthy();
      expect(result.coalesced).toBe(false);
      expect(result.delivered).toBe("new_run");
    }, 30_000);

    it("requestWakeups reports delivery per issue: the busy issue's wake is swallowed while the idle issue's wake delivers", async () => {
      const { companyId, agentId } = await seedCompanyWithAgent("cto");
      const busyIssueId = await seedAssignedIssue(companyId, agentId, "Busy issue");
      const idleIssueId = await seedAssignedIssue(companyId, agentId, "Idle issue");
      const liveRunId = await seedLiveRun(companyId, agentId, { issueId: busyIssueId });

      const results = await bridgeServices().issues.requestWakeups({
        issueIds: [busyIssueId, idleIssueId],
        companyId,
        reason: "some_future_plugin_sweep",
      });

      expect(results).toHaveLength(2);
      const busy = results.find((entry) => entry.issueId === busyIssueId);
      const idle = results.find((entry) => entry.issueId === idleIssueId);
      expect(
        busy,
        "the busy issue's wake coalesces into the live run — the batch entry must say the prompt evaporated",
      ).toEqual({
        issueId: busyIssueId,
        queued: true,
        runId: liveRunId,
        coalesced: true,
        delivered: "merged_running",
      });
      expect(idle?.queued).toBe(true);
      expect(idle?.coalesced).toBe(false);
      expect(idle?.delivered, "a wake scoped to a different issue must not be swallowed by the busy run").toBe("new_run");
      expect(idle?.runId).not.toBe(liveRunId);
    }, 30_000);
  });
});
