import { describe, expect, it, vi } from "vitest";
import { paperclipTriageConfigSchema } from "./config.js";
import {
  PaperclipApiError,
  PaperclipTriageClient,
  buildFeedbackTriageDescription,
  feedbackTriageIntakeSchema,
} from "./paperclip-triage.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const parentId = "00000000-0000-4000-8000-000000000003";
const issueId = "00000000-0000-4000-8000-000000000004";

const intake = {
  asanaTaskGid: "1218079999999999",
  submissionId: "looa-2103-canary-1",
  feedback: "The issue list does not refresh after I close a task.",
  submissionMode: "local_validation" as const,
  validationRunId: "looa-2103-local",
  routeTemplate: "/LOOA/issues/:issueId",
  appVersion: "0.3.1",
  deploymentMode: "local_trusted" as const,
  browser: "Chrome",
  operatingSystem: "macOS",
  clientTimestamp: "2026-09-02T02:00:00.000Z",
  diagnostics: [],
  followUpConsent: true,
};

function config() {
  return paperclipTriageConfigSchema.parse({
    PRODUCT_FEEDBACK_PAPERCLIP_API_URL: "http://127.0.0.1:3132",
    PRODUCT_FEEDBACK_PAPERCLIP_COMPANY_ID: companyId,
    PRODUCT_FEEDBACK_PAPERCLIP_TRIAGE_AGENT_ID: agentId,
    PRODUCT_FEEDBACK_PAPERCLIP_PARENT_ISSUE_ID: parentId,
  });
}

describe("Paperclip feedback triage bridge", () => {
  it("allows only HTTPS or loopback HTTP and requires a task boundary", () => {
    expect(() => paperclipTriageConfigSchema.parse({
      PRODUCT_FEEDBACK_PAPERCLIP_API_URL: "http://paperclip.example.test",
      PRODUCT_FEEDBACK_PAPERCLIP_COMPANY_ID: companyId,
      PRODUCT_FEEDBACK_PAPERCLIP_TRIAGE_AGENT_ID: agentId,
      PRODUCT_FEEDBACK_PAPERCLIP_PARENT_ISSUE_ID: parentId,
    })).toThrow();
    expect(() => paperclipTriageConfigSchema.parse({
      PRODUCT_FEEDBACK_PAPERCLIP_API_URL: "https://paperclip.example.test",
      PRODUCT_FEEDBACK_PAPERCLIP_COMPANY_ID: companyId,
      PRODUCT_FEEDBACK_PAPERCLIP_TRIAGE_AGENT_ID: agentId,
    })).toThrow();
  });

  it("rejects unrecognized fields instead of copying arbitrary Asana data", () => {
    expect(feedbackTriageIntakeSchema.safeParse({
      ...intake,
      reporterEmail: "reporter@example.test",
    }).success).toBe(false);
  });

  it("delimits feedback as untrusted and preserves the routing gates", () => {
    const description = buildFeedbackTriageDescription(intake);
    expect(description).toContain("--- BEGIN UNTRUSTED FEEDBACK ---");
    expect(description).toContain("Never access a user's environment");
    expect(description).toContain("A human must review any PR");
    expect(description).toContain("human reviews the plan, working prototype, and PR");
    expect(description).toContain("follow-up email infrastructure is disabled");
    expect(description).toContain("Slack human-decision gate");
    expect(description).toContain("Discussion replies are advisory");
    expect(description).toContain("fail closed");
    expect(description).toContain("versioned triage-learning example");
  });

  it("creates an assigned task with deterministic dual-key idempotency", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        id: issueId,
        identifier: "LOOA-2200",
        title: "Feedback triage",
        status: "todo",
      }), { status: 201 })
    );
    const client = new PaperclipTriageClient(config());

    await expect(client.createIssue(intake)).resolves.toMatchObject({ id: issueId, status: "todo" });
    await expect(client.createIssue(intake)).resolves.toMatchObject({ id: issueId, status: "todo" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody).toMatchObject({
      assigneeAgentId: agentId,
      parentId,
      status: "todo",
      idempotencyKey: "product-feedback:asana:1218079999999999:submission:looa-2103-canary-1",
      allowDuplicate: true,
    });
    expect(secondBody.idempotencyKey).toBe(firstBody.idempotencyKey);
  });

  it("does not include a vendor response body in errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "sensitive feedback text",
    }), { status: 403 }));

    await expect(new PaperclipTriageClient(config()).createIssue(intake)).rejects.toEqual(
      new PaperclipApiError(403, "paperclip_http_403"),
    );
  });
});
