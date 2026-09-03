import { afterEach, describe, expect, it, vi } from "vitest";
import { AsanaApiError, AsanaClient } from "./asana.js";
import type { PosthogFeedbackDelivery } from "./contracts.js";

const delivery: PosthogFeedbackDelivery = {
  event: "survey sent",
  distinct_id: "a1b2c3d4-1111-4222-8333-123456789abc",
  survey_id: "survey-1",
  question_id: "question-1",
  schema_version: "paperclip-product-feedback-v1",
  feedback: "The issue list does not refresh after I close a task.",
  submission_id: "a1b2c3d4-1111-4222-8333-123456789abc",
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
};

function client() {
  return new AsanaClient({
    accessToken: "asana-token",
    apiBaseUrl: "https://app.asana.test/api/1.0",
    projectGid: "project-1",
    validationSectionGid: "validation-section",
    newSectionGid: "new-section",
    customFields: { "field-1": "option-1" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Asana client", () => {
  it("creates the task in the project and places it in the target section separately", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { gid: "task-1" } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const asana = client();
    await expect(asana.createFeedbackTask(delivery)).resolves.toBe("task-1");
    await expect(asana.placeFeedbackTask("task-1", "local_validation")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.asana.test/api/1.0/tasks");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      data: {
        projects: ["project-1"],
        custom_fields: { "field-1": "option-1" },
      },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://app.asana.test/api/1.0/sections/validation-section/addTask",
    );
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      data: { task: "task-1" },
    });
  });

  it("reports a bounded error when section placement fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [] }), { status: 403 }));

    await expect(client().placeFeedbackTask("task-1", "local_validation")).rejects.toEqual(
      new AsanaApiError(403, "asana_http_403"),
    );
  });

  it("recovers a created task by its trusted submission marker across project pages", async () => {
    const submissionId = delivery.submission_id;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          gid: "untrusted-match",
          notes: [
            "Submission ID: another-submission",
            "--- BEGIN UNTRUSTED FEEDBACK ---",
            `Submission ID: ${submissionId}`,
            "--- END UNTRUSTED FEEDBACK ---",
          ].join("\n"),
        }],
        next_page: { offset: "next-page" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          gid: "task-1",
          notes: [
            `Submission ID: ${submissionId}`,
            "--- BEGIN UNTRUSTED FEEDBACK ---",
            "The issue list does not refresh.",
            "--- END UNTRUSTED FEEDBACK ---",
          ].join("\n"),
        }],
        next_page: null,
      }), { status: 200 }));

    await expect(client().findFeedbackTaskBySubmissionId(submissionId)).resolves.toBe("task-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.pathname).toBe("/api/1.0/tasks");
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      project: "project-1",
      completed_since: "1970-01-01T00:00:00.000Z",
      limit: "100",
      opt_fields: "notes",
    });
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("offset")).toBe("next-page");
  });
});
