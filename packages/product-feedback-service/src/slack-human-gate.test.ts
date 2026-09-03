import { describe, expect, it } from "vitest";
import {
  buildSlackHumanGateMessage,
  buildSlackReviewNotification,
  buildTriageLearningExample,
  selectAuthorizedSlackDecision,
} from "./slack-human-gate.js";

const recommendation = {
  policyVersion: "feedback-triage-v1",
  submissionId: "feedback-123",
  asanaTaskGid: "1218079999999999",
  paperclipIssueIdentifier: "LOOA-2200",
  paperclipIssueUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2200",
  feedbackExcerpt: "Please email me@example.com and open https://evil.test. Token xoxb-123456789012.",
  category: "bug" as const,
  confidence: "high" as const,
  severity: "medium" as const,
  userImpact: "The task list remains stale after closing a task.",
  duplicateAssessment: "No matching root cause found.",
  recommendedAction: "Reproduce locally, then prepare a narrowly scoped fix.",
};

function reply(input: Partial<{ ts: string; userId: string; text: string }> = {}) {
  return {
    channelId: "C12345678",
    threadTs: "1788380000.000001",
    ts: input.ts ?? "1788380001.000001",
    userId: input.userId ?? "U-REVIEWER",
    text: input.text ?? "DECISION: approve\nRATIONALE: Reproduced by the team.",
  };
}

describe("Slack product-feedback human gate", () => {
  it("builds a bounded message without contact data, links, credentials, or mention markup", () => {
    const message = buildSlackHumanGateMessage({
      ...recommendation,
      feedbackExcerpt: `${recommendation.feedbackExcerpt} <@U123> ${"x".repeat(1_000)}`,
    });

    expect(message).toContain("awaiting human decision");
    expect(message).toContain("[redacted email]");
    expect(message).toContain("[link omitted]");
    expect(message).toContain("[redacted credential]");
    expect(message).toContain("&lt;@U123&gt;");
    expect(message).toContain("Also send to channel");
    expect(message).not.toContain("me@example.com");
    expect(message).not.toContain("https://evil.test");
    expect(message).not.toContain("xoxb-123456789012");
    expect(message.length).toBeLessThan(3_500);
  });

  it("builds a task-review reminder for the same thread and configured reviewers", () => {
    const message = buildSlackReviewNotification({
      policyVersion: "feedback-triage-v1",
      submissionId: "feedback-123",
      threadTs: "1788380000.000001",
      stage: "task_review",
      paperclipIssueIdentifier: "LOOA-2201",
      paperclipIssueUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2201",
      reviewTargetLabel: "Prototype revision 1 <@UATTACKER>",
      reviewUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2201#document-prototype",
      summary: "The local prototype is ready. Contact me@example.com.",
    }, ["UREVIEWER"]);

    expect(message).toContain("Task ready for human review");
    expect(message).toContain("<@UREVIEWER>");
    expect(message).toContain("&lt;@UATTACKER&gt;");
    expect(message).toContain("[redacted email]");
    expect(message).toContain("does not resolve the human review gate");
  });

  it("accepts only the Paperclip repository for pull-request reminders", () => {
    const base = {
      policyVersion: "feedback-triage-v1",
      submissionId: "feedback-123",
      threadTs: "1788380000.000001",
      stage: "pull_request_review",
      paperclipIssueIdentifier: "LOOA-2202",
      paperclipIssueUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2202",
      reviewTargetLabel: "PR #123",
      summary: "Focused checks are green.",
    } as const;

    expect(buildSlackReviewNotification({
      ...base,
      reviewUrl: "https://github.com/paperclipai/paperclip/pull/123",
    }, ["UREVIEWER"])).toContain("Pull request ready for human review");
    expect(() => buildSlackReviewNotification({
      ...base,
      reviewUrl: "https://example.com/paperclip/pull/123",
    }, ["UREVIEWER"])).toThrow();
  });

  it("ignores discussion and unauthorized decisions until an allowlisted human decides", () => {
    expect(selectAuthorizedSlackDecision({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      allowedUserIds: ["U-REVIEWER"],
      replies: [
        reply({ userId: "U-OTHER", text: "DECISION: approve\nRATIONALE: Looks good." }),
        reply({ userId: "U-REVIEWER", text: "I think this is probably a bug." }),
      ],
    })).toEqual({ status: "pending", rejectedDecisionReplies: 1 });
  });

  it("requires revised category and action for a revise decision", () => {
    const invalid = selectAuthorizedSlackDecision({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      allowedUserIds: ["U-REVIEWER"],
      replies: [reply({ text: "DECISION: revise\nRATIONALE: This is an idea." })],
    });
    expect(invalid).toEqual({ status: "pending", rejectedDecisionReplies: 1 });

    const valid = selectAuthorizedSlackDecision({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      allowedUserIds: ["U-REVIEWER"],
      replies: [reply({ text: "DECISION: revise\nCATEGORY: idea\nACTION: Research demand before building.\nRATIONALE: The behavior is working as designed." })],
    });
    expect(valid).toMatchObject({
      status: "accepted",
      decision: { action: "revise", category: "idea", revisedAction: "Research demand before building." },
    });
  });

  it("fails closed on competing decisions and permits an explicit superseding decision", () => {
    const first = reply({ ts: "1788380001.000001" });
    const second = reply({
      ts: "1788380002.000001",
      text: "DECISION: defer\nRATIONALE: Wait for another report.",
    });
    expect(selectAuthorizedSlackDecision({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      allowedUserIds: ["U-REVIEWER"],
      replies: [first, second],
    })).toEqual({
      status: "conflict",
      decisionTimestamps: ["1788380001.000001", "1788380002.000001"],
    });

    const superseding = reply({
      ts: "1788380002.000001",
      text: "DECISION: defer\nRATIONALE: Wait for another report.\nSUPERSEDES: 1788380001.000001",
    });
    expect(selectAuthorizedSlackDecision({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      allowedUserIds: ["U-REVIEWER"],
      replies: [first, superseding],
    })).toMatchObject({ status: "accepted", decision: { action: "defer", decisionTs: "1788380002.000001" } });
  });

  it("creates a versioned learning example with decision provenance and redacted discussion", () => {
    const selected = selectAuthorizedSlackDecision({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      allowedUserIds: ["U-REVIEWER"],
      replies: [reply()],
    });
    if (selected.status !== "accepted") throw new Error("expected accepted decision");

    const example = buildTriageLearningExample({
      recommendation,
      decision: selected.decision,
      discussionSummary: "The team reproduced it. Contact me@example.com. See https://private.test for details.",
      capturedAt: new Date("2026-09-02T22:00:00.000Z"),
    });

    expect(example).toMatchObject({
      version: 1,
      policyVersion: "feedback-triage-v1",
      acceptedDecision: { action: "approve", rationale: "Reproduced by the team." },
      provenance: { actorUserId: "U-REVIEWER", decisionTs: "1788380001.000001" },
    });
    expect(example.exampleId).toMatch(/^[a-f0-9]{64}$/);
    expect(example.discussionSummary).toContain("[redacted email]");
    expect(example.discussionSummary).toContain("[link omitted]");
  });
});
