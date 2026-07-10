import { and, eq, inArray } from "drizzle-orm";
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
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
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

  try {
    const existing = await findExistingDeliverableWriteEscalationWake(db, {
      companyId: input.companyId,
      idempotencyKey: wake.idempotencyKey,
    });
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
    return { outcome: queued ? "scheduled" : "skipped", ...base };
  } catch {
    return { outcome: "failed", ...base };
  }
}
