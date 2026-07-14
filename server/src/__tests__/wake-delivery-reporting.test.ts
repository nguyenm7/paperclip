import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

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

  async function seedCompanyWithAgent(role: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", status: "active" });
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
  async function seedLiveRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
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

      runningProcesses.clear();
      await db.execute(sql`truncate table companies cascade`);
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
});
