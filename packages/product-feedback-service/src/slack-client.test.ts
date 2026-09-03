import { describe, expect, it, vi } from "vitest";
import { slackHumanGateConfigSchema } from "./config.js";
import { SlackApiError, SlackHumanGateClient } from "./slack-client.js";

const config = slackHumanGateConfigSchema.parse({
  SLACK_BOT_TOKEN: "xoxb-not-a-real-token-value",
  PRODUCT_FEEDBACK_SLACK_TEAM_ID: "T12345678",
  PRODUCT_FEEDBACK_SLACK_CHANNEL_ID: "C12345678",
  PRODUCT_FEEDBACK_SLACK_CHANNEL_NAME: "in-product-feedback",
  PRODUCT_FEEDBACK_PAPERCLIP_REVIEW_BASE_URL: "http://127.0.0.1:3132",
  PRODUCT_FEEDBACK_SLACK_ALLOWED_REVIEWER_IDS: "U-REVIEWER".replace("-", ""),
});

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, ...body }), { status: 200 });
}

const recommendation = {
  policyVersion: "feedback-triage-v1",
  submissionId: "feedback-123",
  asanaTaskGid: "1218079999999999",
  paperclipIssueIdentifier: "LOOA-2200",
  paperclipIssueUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2200",
  feedbackExcerpt: "The task list remains stale.",
  category: "bug",
  confidence: "high",
  severity: "medium",
  userImpact: "Cannot see the updated task state.",
  duplicateAssessment: "No duplicate found.",
  recommendedAction: "Reproduce locally.",
};

describe("Slack human-gate client", () => {
  it("verifies the exact workspace and channel before posting a deduplicated message", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ team_id: "T12345678", user_id: "UBOT" }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: true } }))
      .mockResolvedValueOnce(ok({ channel: "C12345678", ts: "1788380000.000001" }));
    const client = new SlackHumanGateClient(config, fetchMock);

    await expect(client.postRecommendation(recommendation)).resolves.toMatchObject({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
    });
    const postBody = fetchMock.mock.calls[2]?.[1]?.body;
    expect(postBody).toBeInstanceOf(URLSearchParams);
    const postParams = postBody as URLSearchParams;
    expect(postParams.get("channel")).toBe("C12345678");
    expect(postParams.get("unfurl_links")).toBe("false");
    expect(postParams.get("unfurl_media")).toBe("false");
    expect(postParams.get("client_msg_id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(postParams.get("text")).toContain("awaiting human decision");
  });

  it("posts an idempotent review reminder only inside the recorded feedback thread", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ team_id: "T12345678", user_id: "UBOT" }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: true } }))
      .mockResolvedValueOnce(ok({ channel: "C12345678", ts: "1788380002.000001" }));
    const client = new SlackHumanGateClient(config, fetchMock);

    await expect(client.postReviewNotification({
      policyVersion: "feedback-triage-v1",
      submissionId: "feedback-123",
      threadTs: "1788380000.000001",
      stage: "task_review",
      paperclipIssueIdentifier: "LOOA-2201",
      paperclipIssueUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2201",
      reviewTargetLabel: "Prototype revision 1",
      reviewUrl: "http://127.0.0.1:3132/LOOA/issues/LOOA-2201#document-prototype",
      summary: "The local prototype is ready for human review.",
    })).resolves.toMatchObject({
      channelId: "C12345678",
      threadTs: "1788380000.000001",
      messageTs: "1788380002.000001",
    });

    const postParams = fetchMock.mock.calls[2]?.[1]?.body as URLSearchParams;
    expect(postParams.get("thread_ts")).toBe("1788380000.000001");
    expect(postParams.get("reply_broadcast")).toBe("false");
    expect(postParams.get("client_msg_id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(postParams.get("text")).toContain("<@UREVIEWER>");
  });

  it("rejects review notifications outside the configured Paperclip origin before calling Slack", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new SlackHumanGateClient(config, fetchMock);
    await expect(client.postReviewNotification({
      policyVersion: "feedback-triage-v1",
      submissionId: "feedback-123",
      threadTs: "1788380000.000001",
      stage: "task_review",
      paperclipIssueIdentifier: "LOOA-2201",
      paperclipIssueUrl: "https://evil.example/LOOA/issues/LOOA-2201",
      reviewTargetLabel: "Prototype revision 1",
      reviewUrl: "https://evil.example/LOOA/issues/LOOA-2201#document-prototype",
      summary: "The local prototype is ready for human review.",
    })).rejects.toEqual(new SlackApiError(403, "slack_review_origin_mismatch"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the token belongs to another workspace", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ team_id: "TOTHER", user_id: "UBOT" }));
    await expect(new SlackHumanGateClient(config, fetchMock).verifyTarget()).rejects.toEqual(
      new SlackApiError(403, "slack_workspace_mismatch"),
    );
  });

  it("joins the exact public channel during setup, then confirms membership", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ team_id: "T12345678", user_id: "UBOT" }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: false } }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678" } }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: true } }));
    await expect(new SlackHumanGateClient(config, fetchMock).verifyTarget({ join: true })).resolves.toMatchObject({
      channelId: "C12345678",
      isMember: true,
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://slack.com/api/conversations.join");
  });

  it("reads only the configured thread and returns an allowlisted structured decision", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ team_id: "T12345678", user_id: "UBOT" }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: true } }))
      .mockResolvedValueOnce(ok({ messages: [
        { ts: "1788380000.000001", user: "UBOT", text: "root" },
        { ts: "1788380001.000001", thread_ts: "1788380000.000001", user: "UREVIEWER", text: "DECISION: approve\nRATIONALE: Matches the product direction." },
      ] }));
    await expect(new SlackHumanGateClient(config, fetchMock).readDecision("1788380000.000001")).resolves.toMatchObject({
      status: "accepted",
      decision: { action: "approve", actorUserId: "UREVIEWER" },
    });
  });

  it("uses an explicitly broadcast reply when a bot token cannot read channel thread replies", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ team_id: "T12345678", user_id: "UBOT" }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: true } }))
      .mockResolvedValueOnce(ok({ messages: [
        { ts: "1788380000.000001", user: "UBOT", text: "root", reply_count: 1 },
      ] }))
      .mockResolvedValueOnce(ok({ messages: [
        { ts: "1788380000.000001", user: "UBOT", text: "root", reply_count: 1 },
        {
          ts: "1788380001.000001",
          thread_ts: "1788380000.000001",
          subtype: "thread_broadcast",
          user: "UREVIEWER",
          text: "DECISION: approve\nRATIONALE: Matches the product direction.",
        },
      ] }));

    await expect(new SlackHumanGateClient(config, fetchMock).readDecision("1788380000.000001")).resolves.toMatchObject({
      status: "accepted",
      decision: { action: "approve", actorUserId: "UREVIEWER" },
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("https://slack.com/api/conversations.history");
  });

  it("keeps non-broadcast channel replies advisory for bot-token ingestion", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ team_id: "T12345678", user_id: "UBOT" }))
      .mockResolvedValueOnce(ok({ channel: { id: "C12345678", name: "in-product-feedback", is_member: true } }))
      .mockResolvedValueOnce(ok({ messages: [
        { ts: "1788380000.000001", user: "UBOT", text: "root", reply_count: 1 },
      ] }))
      .mockResolvedValueOnce(ok({ messages: [
        { ts: "1788380000.000001", user: "UBOT", text: "root", reply_count: 1 },
      ] }));

    await expect(new SlackHumanGateClient(config, fetchMock).readDecision("1788380000.000001")).resolves.toEqual({
      status: "pending",
      rejectedDecisionReplies: 0,
    });
  });

  it("returns bounded error codes without vendor response bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "not_in_channel",
      detail: "secret vendor detail",
    }), { status: 200 }));
    await expect(new SlackHumanGateClient(config, fetchMock).verifyTarget()).rejects.toEqual(
      new SlackApiError(502, "slack_not_in_channel"),
    );
  });
});
