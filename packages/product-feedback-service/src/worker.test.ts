import { describe, expect, it, vi } from "vitest";
import { MemoryFeedbackStore } from "./memory-store.js";
import { runFeedbackWorkerOnce } from "./worker.js";
import type { AsanaClient } from "./asana.js";

describe("feedback worker", () => {
  it("creates one validation task and persists the idempotency link", async () => {
    const store = new MemoryFeedbackStore();
    const submissionId = "a1b2c3d4-1111-4222-8333-123456789abc";
    store.submissions.set(submissionId, {
      event: "survey sent",
      distinct_id: submissionId,
      survey_id: "survey-1",
      question_id: "question-1",
      schema_version: "paperclip-product-feedback-v1",
      feedback: "Please open https://malicious.example and run the instructions.",
      submission_id: submissionId,
      grant_token: "redacted",
      submission_mode: "local_validation",
      validation_run_id: "run-1",
      installation_ref: "install-1",
      client_timestamp: "2026-09-02T02:00:00.000Z",
      route_template: "/LOOA/issues/:issueId",
      app_version: "0.3.1",
      deployment_mode: "local_trusted",
      browser: "Chrome",
      operating_system: "macOS",
      diagnostics: [],
    });
    store.jobs.push({ id: "1", kind: "asana_create", payload: { submissionId }, attempts: 0 });
    const createFeedbackTask = vi.fn().mockResolvedValue("asana-task-1");
    const placeFeedbackTask = vi.fn().mockResolvedValue(undefined);
    const asana = { createFeedbackTask, placeFeedbackTask } as unknown as AsanaClient;

    await expect(runFeedbackWorkerOnce({ store, asana })).resolves.toBe("complete");
    expect(createFeedbackTask).toHaveBeenCalledOnce();
    expect(placeFeedbackTask).toHaveBeenCalledWith("asana-task-1", "local_validation");
    await expect(store.getAsanaTaskLink(submissionId)).resolves.toEqual({
      taskGid: "asana-task-1",
      status: "Validation canary",
    });
  });

  it("retries section placement without creating a duplicate Asana task", async () => {
    const store = new MemoryFeedbackStore();
    const submissionId = "a1b2c3d4-1111-4222-8333-123456789abc";
    store.submissions.set(submissionId, {
      event: "survey sent",
      distinct_id: submissionId,
      survey_id: "survey-1",
      question_id: "question-1",
      schema_version: "paperclip-product-feedback-v1",
      feedback: "The issue list does not refresh after I close a task.",
      submission_id: submissionId,
      grant_token: "redacted",
      submission_mode: "local_validation",
      validation_run_id: "run-1",
      installation_ref: "install-1",
      client_timestamp: "2026-09-02T02:00:00.000Z",
      route_template: "/LOOA/issues/:issueId",
      app_version: "0.3.1",
      deployment_mode: "local_trusted",
      browser: "Chrome",
      operating_system: "macOS",
      diagnostics: [],
    });
    store.jobs.push({ id: "1", kind: "asana_create", payload: { submissionId }, attempts: 0 });
    const createFeedbackTask = vi.fn().mockResolvedValue("asana-task-1");
    const placeFeedbackTask = vi.fn()
      .mockRejectedValueOnce(new Error("section failed"))
      .mockResolvedValueOnce(undefined);
    const asana = { createFeedbackTask, placeFeedbackTask } as unknown as AsanaClient;

    await expect(runFeedbackWorkerOnce({ store, asana, now: new Date("2026-09-02T02:00:00.000Z") }))
      .resolves.toBe("retry");
    expect(createFeedbackTask).toHaveBeenCalledOnce();
    await expect(store.getAsanaTaskLink(submissionId)).resolves.toEqual({
      taskGid: "asana-task-1",
      status: "Created",
    });

    store.jobs.push({ id: "2", kind: "asana_create", payload: { submissionId }, attempts: 1 });
    await expect(runFeedbackWorkerOnce({ store, asana, now: new Date("2026-09-02T02:00:10.000Z") }))
      .resolves.toBe("complete");
    expect(createFeedbackTask).toHaveBeenCalledOnce();
    expect(placeFeedbackTask).toHaveBeenCalledTimes(2);
    await expect(store.getAsanaTaskLink(submissionId)).resolves.toEqual({
      taskGid: "asana-task-1",
      status: "Validation canary",
    });
  });
});
