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

// LOOA-335 (verification of LOOA-321 against the LOOA-334 class): the gateway
// aging-gate sweep wakes a gate's creator through the plugin bridge —
// ctx.agents.invoke → plugin-host-services → heartbeat.wakeup with
// source "automation", payload { prompt }, and NO issueId/taskKey — and stamps
// a 7-day re-nudge marker (lastNudgedAt) as soon as the invoke resolves.
//
// A wake with no issue scope shares the null task scope with the creator's
// ordinary runs. When the creator already has a LIVE (tracked, non-zombie)
// run, enqueueWakeup coalesces: it merges the prompt into that run's
// contextSnapshot and returns the run. The adapter process was spawned with
// its prompt before the merge and never re-reads the column, so the Rule-11
// question is never rendered — yet the sweep sees a truthy run ref, stamps
// lastNudgedAt, and its ledger (nudge count, "creator wake(s) sent" log)
// claims delivery. The creators most likely to sit on aging gates are the
// busy ones — exactly the ones most likely to be mid-run when the hourly
// sweep fires. The escalation path (aging_gate_rule11_escalation) has the
// same seam and additionally logs "escalated to manager" on a swallowed wake.
//
// heartbeat.ts already has the guard for this hazard —
// RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP — which forces a NEW queued
// run instead of coalescing into a live one. This suite pins that both aging
// wake reasons are on that list. The reason strings are defined in the
// gateway repo (paperclip-gateway/src/aging.ts: AGING_WAKE_REASON and
// AGING_WAKE_REASON_ESCALATION) and are duplicated here as literals because
// the two repos share no package; if the sweep renames its reasons, this
// suite must follow.
//
// The invariant: a sweep must never stamp a raise-once/re-nudge marker unless
// the wake got a run that will actually render its prompt. A stubbed wakeup
// cannot catch this — the defect lives at the seam, so the test drives the
// real one.

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
    `Skipping aging-gate wake delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("aging-gate wake delivery vs. wake coalescing (LOOA-335)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-aging-gate-delivery-");
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
   * is mid-flight when the hourly sweep fires. Registering it in
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

  /**
   * Any run that actually carries the nudge prompt as its own wake message.
   * The run may already have advanced past `queued` (enqueueWakeup kicks
   * startNextQueuedRunForAgent), so status is not part of the predicate —
   * what matters is that the wake got a run of its OWN, distinct from a run
   * that was already live before the sweep fired.
   */
  async function runsCarryingThePrompt(agentId: string, excludeRunId: string, marker: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return runs.filter(
      (run) =>
        run.id !== excludeRunId &&
        String((run.contextSnapshot as Record<string, unknown> | null)?.wakeMessage ?? "").includes(marker),
    );
  }

  it("a Rule-11 creator nudge (aging_gate_rule11) reaches a mid-run creator as its own follow-up run, not a merge into the live one", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("cto");
    const liveRunId = await seedLiveRun(companyId, agentId);

    const prompt = "Aging-gate sweep (gate-policy Rule 11): your gate `abc12345` has been pending 9 days.";
    const run = await invokeAsPluginBridge(agentId, "aging_gate_rule11", prompt);

    // The run ref the sweep stamps lastNudgedAt on must not be the run that
    // was already mid-flight before the sweep fired: that process was spawned
    // with its prompt and will never render the merged wakeMessage.
    expect(run).toBeTruthy();
    expect(
      run!.id,
      "wakeup returned the creator's pre-existing live run — the nudge was coalesced into a process that will never render it, while the sweep stamps a 7-day re-nudge marker and logs the wake as sent",
    ).not.toBe(liveRunId);

    const carriers = await runsCarryingThePrompt(agentId, liveRunId, "Aging-gate sweep");
    expect(
      carriers.length,
      "no run of its own carries the Rule-11 nudge prompt — the creator being mid-run swallowed the question for the whole AGING_RENUDGE_DAYS window",
    ).toBeGreaterThan(0);
  }, 30_000);

  it("a manager-chain escalation (aging_gate_rule11_escalation) reaches a mid-run manager as its own follow-up run", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent("ceo");
    const liveRunId = await seedLiveRun(companyId, agentId);

    const prompt =
      "Aging-gate sweep escalation (gate-policy Rule 11): a gate's creator could not be woken; you own routing this.";
    const run = await invokeAsPluginBridge(agentId, "aging_gate_rule11_escalation", prompt);

    // Same seam, worse ledger: on a coalesced escalation the sweep logs
    // "escalated ... to manager" and stops climbing the chain, so a swallowed
    // wake here leaves the gate with no live owner at all.
    expect(run).toBeTruthy();
    expect(run!.id).not.toBe(liveRunId);

    const carriers = await runsCarryingThePrompt(agentId, liveRunId, "Aging-gate sweep escalation");
    expect(
      carriers.length,
      "no run of its own carries the escalation prompt — the manager being mid-run swallowed the escalation while the sweep logged it as delivered",
    ).toBeGreaterThan(0);
  }, 30_000);
});
