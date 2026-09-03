import { randomUUID } from "node:crypto";
import type { FeedbackStore, QueueJob } from "./store.js";
import { AsanaClient, AsanaApiError } from "./asana.js";

function retryDelay(attempts: number): number {
  return Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1)));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AsanaApiError) return error.code;
  return "worker_failure";
}

async function handleAsanaCreate(store: FeedbackStore, asana: AsanaClient, job: QueueJob): Promise<void> {
  const submissionId = job.payload.submissionId;
  if (typeof submissionId !== "string") throw new Error("invalid_job_payload");
  const submission = await store.getSubmission(submissionId);
  if (!submission) throw new Error("submission_missing");
  const targetStatus = submission.submission_mode === "local_validation" ? "Validation canary" : "New";
  let link = await store.getAsanaTaskLink(submissionId);
  if (!link && job.attempts > 1) {
    const recoveredTaskGid = await asana.findFeedbackTaskBySubmissionId(submissionId);
    if (recoveredTaskGid) {
      await store.saveAsanaTaskLink({ submissionId, taskGid: recoveredTaskGid, status: "Created" });
      link = { taskGid: recoveredTaskGid, status: "Created" };
    }
  }
  if (!link) {
    const taskGid = await asana.createFeedbackTask(submission);
    await store.saveAsanaTaskLink({ submissionId, taskGid, status: "Created" });
    link = { taskGid, status: "Created" };
  }
  if (link.status === targetStatus) return;
  await asana.placeFeedbackTask(link.taskGid, submission.submission_mode);
  await store.saveAsanaTaskLink({ submissionId, taskGid: link.taskGid, status: targetStatus });
}

async function handleAsanaReconcile(asana: AsanaClient, job: QueueJob): Promise<void> {
  const events = Array.isArray(job.payload.events) ? job.payload.events : [];
  const taskGids = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const resource = (event as { resource?: unknown }).resource;
    if (!resource || typeof resource !== "object") continue;
    const gid = (resource as { gid?: unknown }).gid;
    const resourceType = (resource as { resource_type?: unknown }).resource_type;
    if (resourceType === "task" && typeof gid === "string") taskGids.add(gid);
  }
  for (const taskGid of taskGids) await asana.getTask(taskGid);
}

export async function runFeedbackWorkerOnce(input: {
  store: FeedbackStore;
  asana: AsanaClient;
  now?: Date;
  workerId?: string;
}): Promise<"idle" | "complete" | "retry" | "dead"> {
  const now = input.now ?? new Date();
  const job = await input.store.claimQueueJob(input.workerId ?? randomUUID(), now);
  if (!job) return "idle";
  try {
    if (job.kind === "asana_create") await handleAsanaCreate(input.store, input.asana, job);
    else await handleAsanaReconcile(input.asana, job);
    await input.store.completeQueueJob(job.id);
    return "complete";
  } catch (error) {
    const dead = job.attempts >= 8;
    await input.store.retryQueueJob(
      job.id,
      safeErrorCode(error),
      new Date(now.getTime() + retryDelay(job.attempts)),
      dead,
    );
    return dead ? "dead" : "retry";
  }
}
