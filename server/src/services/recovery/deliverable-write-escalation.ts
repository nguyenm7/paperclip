import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";
import { RECOVERY_REASON_KINDS } from "./origins.js";

export const DELIVERABLE_WRITE_ESCALATION_REASON = RECOVERY_REASON_KINDS.deliverableWriteEscalation;

// Human-readable escalation path, surfaced in the guard's 403 body so an agent
// hitting the denial can see how the pending write actually gets performed
// instead of discovering the mechanism from server source.
export const DELIVERABLE_WRITE_ESCALATION_PATH =
  "A one-shot normal-model wake (reason `recovery_deliverable_write_escalation`) is scheduled for this issue and " +
  "is permitted to perform the denied write. Do not retry the write in this status-only run; report status and exit.";

const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_issue_execution", "completed"];

// Mirrors DEFERRED_WAKE_CONTEXT_KEY in services/heartbeat.ts, which cannot be
// imported here without a cycle (heartbeat.ts imports this module via
// ./recovery/index.js). When a wake for an issue that already has a deferred
// wake merges into that row, the incoming idempotencyKey is dropped — the only
// trace of the escalation is inside the merged context stored under this key.
const DEFERRED_WAKE_CONTEXT_PAYLOAD_KEY = "_paperclipWakeContext";

export function buildDeliverableWriteEscalationIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
}) {
  // Keyed by source run so each status-only recovery run can escalate at most
  // once, which bounds the cheap->normal amplification to 1:1 per recovery run.
  return [DELIVERABLE_WRITE_ESCALATION_REASON, input.issueId, input.sourceRunId].join(":");
}

export async function findExistingDeliverableWriteEscalationWake(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    sourceRunId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        or(
          and(
            eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
            inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
          ),
          // An escalation merged into a pre-existing deferred wake for the same
          // issue loses its idempotencyKey but still delivers on promotion; it
          // is only recognizable by the escalation marker in the merged context.
          and(
            eq(agentWakeupRequests.agentId, input.agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
            sql`${agentWakeupRequests.payload} -> ${DEFERRED_WAKE_CONTEXT_PAYLOAD_KEY} ->> 'deliverableWriteEscalationSourceRunId' = ${input.sourceRunId}`,
          ),
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function buildDeliverableWriteEscalationWake(input: {
  issueId: string;
  sourceRunId: string;
  deniedMutation: { method: string; path: string };
}) {
  const idempotencyKey = buildDeliverableWriteEscalationIdempotencyKey(input);
  const instruction = [
    "A cheap status-only recovery run on this issue was denied a deliverable write.",
    `Denied request: ${input.deniedMutation.method} ${input.deniedMutation.path}.`,
    "This run is on a normal model and is permitted to perform document, plan, and artifact writes:",
    "perform the pending write now, then give the issue a real disposition.",
  ].join(" ");

  return {
    reason: DELIVERABLE_WRITE_ESCALATION_REASON,
    idempotencyKey,
    payload: withRecoveryModelProfileHint({
      issueId: input.issueId,
      sourceRunId: input.sourceRunId,
      deniedMutation: input.deniedMutation,
      instruction,
    }, "normal_model"),
    contextSnapshot: withRecoveryModelProfileHint({
      issueId: input.issueId,
      taskId: input.issueId,
      taskKey: input.issueId,
      wakeReason: DELIVERABLE_WRITE_ESCALATION_REASON,
      // The source run is RUNNING when this wake is enqueued — it is the run
      // making the denied HTTP request. Without forceFreshSession the wake
      // coalesces into that run, whose process was spawned with its prompt
      // before the merge and never re-reads the context column: the escalation
      // instruction would never render (LOOA-347, the LOOA-334 class).
      // forceFreshSession makes shouldDeferFollowupWakeForSameIssue park the
      // wake as deferred_issue_execution instead; releaseIssueExecutionAndPromote
      // promotes it to a run of its own once the source run reports status and
      // exits — exactly the one-shot semantics the 403 body advertises.
      forceFreshSession: true,
      deliverableWriteEscalationSourceRunId: input.sourceRunId,
      deliverableWriteEscalationDeniedMutation: input.deniedMutation,
      deliverableWriteEscalationInstruction: instruction,
    }, "normal_model"),
  };
}

type EscalationEnqueueWakeup = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "system";
    requestedByActorId: string;
  },
) => Promise<unknown>;

export type DeliverableWriteEscalationOutcome =
  | "scheduled"
  | "already_scheduled"
  | "skipped"
  | "failed";

export interface DeliverableWriteEscalationResult {
  outcome: DeliverableWriteEscalationOutcome;
  wakeReason: typeof DELIVERABLE_WRITE_ESCALATION_REASON;
  idempotencyKey: string;
  escalationPath: typeof DELIVERABLE_WRITE_ESCALATION_PATH;
}

function readWakeDelivered(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const delivered = (result as { delivered?: unknown }).delivered;
  return typeof delivered === "string" ? delivered : null;
}

// Best-effort by design: the caller is about to fail the request closed with a
// 403 either way, so escalation problems must never turn the denial into a 500.
export async function scheduleDeliverableWriteEscalation(
  db: Db,
  enqueueWakeup: EscalationEnqueueWakeup,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    sourceRunId: string;
    deniedMutation: { method: string; path: string };
  },
): Promise<DeliverableWriteEscalationResult> {
  const wake = buildDeliverableWriteEscalationWake(input);
  const base = {
    wakeReason: wake.reason,
    idempotencyKey: wake.idempotencyKey,
    escalationPath: DELIVERABLE_WRITE_ESCALATION_PATH,
  } as const;

  const probeInput = {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    sourceRunId: input.sourceRunId,
    idempotencyKey: wake.idempotencyKey,
  };

  try {
    const existing = await findExistingDeliverableWriteEscalationWake(db, probeInput);
    if (existing) {
      return { outcome: "already_scheduled", ...base };
    }

    const queued = await enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: wake.reason,
      payload: wake.payload,
      contextSnapshot: wake.contextSnapshot,
      idempotencyKey: wake.idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "recovery_deliverable_write_escalation",
    });

    if (!queued) {
      // enqueueWakeup returns null both for a DEFERRED wake (parked as
      // deferred_issue_execution because the source run is still live; promoted
      // to a real run when it exits — i.e. scheduled) and for a genuinely
      // suppressed wake (inactive company, heartbeat off). Only the ledger can
      // tell them apart; never claim "scheduled" without a row that proves it.
      const deferred = await findExistingDeliverableWriteEscalationWake(db, probeInput);
      return { outcome: deferred ? "scheduled" : "skipped", ...base };
    }

    // Belt-and-braces for the LOOA-334 class: a truthy run ref whose delivery
    // report says the prompt merged into an already-running process is NOT a
    // scheduled escalation — that prompt will never render.
    if (readWakeDelivered(queued) === "merged_running") {
      return { outcome: "failed", ...base };
    }

    return { outcome: "scheduled", ...base };
  } catch {
    return { outcome: "failed", ...base };
  }
}
