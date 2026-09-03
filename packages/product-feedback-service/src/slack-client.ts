import { createHash } from "node:crypto";
import { z } from "zod";
import type { SlackHumanGateConfig } from "./config.js";
import {
  buildSlackHumanGateMessage,
  buildSlackReviewNotification,
  selectAuthorizedSlackDecision,
  type SlackDecisionSelection,
} from "./slack-human-gate.js";

const slackTimestampSchema = z.string().regex(/^\d{10,}\.\d{6}$/);
const slackEnvelopeSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
}).passthrough();

const slackMessagesEnvelopeSchema = z.object({
  has_more: z.boolean().optional().default(false),
  response_metadata: z.object({
    next_cursor: z.string().optional().default(""),
  }).passthrough().optional(),
  messages: z.array(z.object({
    ts: slackTimestampSchema,
    thread_ts: slackTimestampSchema.optional(),
    user: z.string().optional(),
    text: z.string().optional().default(""),
    subtype: z.string().optional(),
    reply_count: z.number().int().nonnegative().optional().default(0),
  }).passthrough()),
}).passthrough();

export class SlackApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function deterministicClientMessageId(submissionId: string): string {
  const hex = createHash("sha256").update(`paperclip-product-feedback:${submissionId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function deterministicReviewClientMessageId(input: {
  submissionId: string;
  stage: string;
  reviewUrl: string;
}): string {
  const seed = `paperclip-product-feedback-review:${input.submissionId}:${input.stage}:${input.reviewUrl}`;
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export class SlackHumanGateClient {
  constructor(
    private readonly config: SlackHumanGateConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body ?? {})) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form,
    });
    if (!response.ok) throw new SlackApiError(response.status, "slack_transport_failure");
    const raw: unknown = await response.json();
    const envelope = slackEnvelopeSchema.safeParse(raw);
    if (!envelope.success) throw new SlackApiError(502, "slack_invalid_response");
    if (!envelope.data.ok) {
      const safeCode = /^[-a-z0-9_]{1,100}$/.test(envelope.data.error ?? "")
        ? `slack_${envelope.data.error}`
        : "slack_api_failure";
      throw new SlackApiError(502, safeCode);
    }
    return envelope.data;
  }

  async verifyTarget(options: { join?: boolean } = {}): Promise<{
    teamId: string;
    botUserId: string;
    channelId: string;
    channelName: string;
    isMember: boolean;
  }> {
    const auth = await this.call("auth.test");
    const authParsed = z.object({ team_id: z.string(), user_id: z.string() }).passthrough().safeParse(auth);
    if (!authParsed.success) throw new SlackApiError(502, "slack_invalid_auth_response");
    if (authParsed.data.team_id !== this.config.PRODUCT_FEEDBACK_SLACK_TEAM_ID) {
      throw new SlackApiError(403, "slack_workspace_mismatch");
    }

    let info = await this.call("conversations.info", {
      channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
      include_num_members: false,
    });
    let parsed = z.object({
      channel: z.object({
        id: z.string(),
        name: z.string(),
        is_archived: z.boolean().optional().default(false),
        is_member: z.boolean().optional().default(false),
      }).passthrough(),
    }).passthrough().safeParse(info);
    if (!parsed.success) throw new SlackApiError(502, "slack_invalid_channel_response");
    if (parsed.data.channel.id !== this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID
      || parsed.data.channel.name !== this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_NAME) {
      throw new SlackApiError(403, "slack_channel_mismatch");
    }
    if (parsed.data.channel.is_archived) throw new SlackApiError(409, "slack_channel_archived");

    if (!parsed.data.channel.is_member && options.join) {
      await this.call("conversations.join", { channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID });
      info = await this.call("conversations.info", { channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID });
      parsed = z.object({
        channel: z.object({
          id: z.string(),
          name: z.string(),
          is_archived: z.boolean().optional().default(false),
          is_member: z.boolean().optional().default(false),
        }).passthrough(),
      }).passthrough().safeParse(info);
      if (!parsed.success) throw new SlackApiError(502, "slack_invalid_channel_response");
    }
    if (!parsed.data.channel.is_member) throw new SlackApiError(403, "slack_bot_not_in_channel");

    return {
      teamId: authParsed.data.team_id,
      botUserId: authParsed.data.user_id,
      channelId: parsed.data.channel.id,
      channelName: parsed.data.channel.name,
      isMember: true,
    };
  }

  async postRecommendation(rawRecommendation: unknown): Promise<{
    channelId: string;
    threadTs: string;
    messageHash: string;
  }> {
    const recommendation = z.object({ submissionId: z.string().min(1) }).passthrough().parse(rawRecommendation);
    await this.verifyTarget();
    const text = buildSlackHumanGateMessage(rawRecommendation);
    const response = await this.call("chat.postMessage", {
      channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
      text,
      unfurl_links: "false",
      unfurl_media: "false",
      client_msg_id: deterministicClientMessageId(recommendation.submissionId),
    });
    const posted = z.object({ channel: z.string(), ts: slackTimestampSchema }).passthrough().safeParse(response);
    if (!posted.success || posted.data.channel !== this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID) {
      throw new SlackApiError(502, "slack_invalid_post_response");
    }
    return {
      channelId: posted.data.channel,
      threadTs: posted.data.ts,
      messageHash: createHash("sha256").update(text).digest("hex"),
    };
  }

  async postReviewNotification(rawNotification: unknown): Promise<{
    channelId: string;
    threadTs: string;
    messageTs: string;
    messageHash: string;
  }> {
    const notification = z.object({
      submissionId: z.string().min(1),
      threadTs: slackTimestampSchema,
      stage: z.string().min(1),
      paperclipIssueUrl: z.string().url(),
      reviewUrl: z.string().url(),
    }).passthrough().parse(rawNotification);
    if (new URL(notification.paperclipIssueUrl).origin !== this.config.PRODUCT_FEEDBACK_PAPERCLIP_REVIEW_BASE_URL) {
      throw new SlackApiError(403, "slack_review_origin_mismatch");
    }
    await this.verifyTarget();
    const text = buildSlackReviewNotification(
      rawNotification,
      this.config.PRODUCT_FEEDBACK_SLACK_ALLOWED_REVIEWER_IDS,
    );
    const response = await this.call("chat.postMessage", {
      channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
      thread_ts: notification.threadTs,
      text,
      unfurl_links: "false",
      unfurl_media: "false",
      reply_broadcast: "false",
      client_msg_id: deterministicReviewClientMessageId(notification),
    });
    const posted = z.object({ channel: z.string(), ts: slackTimestampSchema }).passthrough().safeParse(response);
    if (!posted.success || posted.data.channel !== this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID) {
      throw new SlackApiError(502, "slack_invalid_post_response");
    }
    return {
      channelId: posted.data.channel,
      threadTs: notification.threadTs,
      messageTs: posted.data.ts,
      messageHash: createHash("sha256").update(text).digest("hex"),
    };
  }

  async readDecision(threadTs: string): Promise<SlackDecisionSelection> {
    const normalizedThreadTs = slackTimestampSchema.parse(threadTs);
    await this.verifyTarget();
    const response = await this.call("conversations.replies", {
      channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
      ts: normalizedThreadTs,
      inclusive: true,
      limit: 100,
    });
    const parsed = slackMessagesEnvelopeSchema.safeParse(response);
    if (!parsed.success) throw new SlackApiError(502, "slack_invalid_thread_response");
    if (parsed.data.has_more || parsed.data.response_metadata?.next_cursor) {
      throw new SlackApiError(409, "slack_thread_too_large");
    }

    const replies = parsed.data.messages
      .filter((message) => message.ts !== normalizedThreadTs && message.user)
      .map((message) => ({
        channelId: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
        threadTs: message.thread_ts ?? normalizedThreadTs,
        ts: message.ts,
        userId: message.user!,
        text: message.text,
      }));
    const declaredReplyCount = parsed.data.messages.find((message) => message.ts === normalizedThreadTs)?.reply_count ?? 0;
    if (declaredReplyCount <= replies.length) {
      return selectAuthorizedSlackDecision({
        channelId: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
        threadTs: normalizedThreadTs,
        allowedUserIds: this.config.PRODUCT_FEEDBACK_SLACK_ALLOWED_REVIEWER_IDS,
        replies,
      });
    }

    // Slack bot tokens cannot retrieve public/private channel replies through
    // conversations.replies. A reply explicitly broadcast to the channel is a
    // thread_broadcast record in conversations.history, so the local demo makes
    // that visible action the formal decision boundary. Non-broadcast replies
    // remain advisory discussion and cannot accidentally authorize work.
    const historyResponse = await this.call("conversations.history", {
      channel: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
      oldest: normalizedThreadTs,
      inclusive: true,
      limit: 100,
    });
    const history = slackMessagesEnvelopeSchema.safeParse(historyResponse);
    if (!history.success) throw new SlackApiError(502, "slack_invalid_history_response");
    if (history.data.has_more || history.data.response_metadata?.next_cursor) {
      throw new SlackApiError(409, "slack_channel_history_too_large");
    }
    const broadcastReplies = history.data.messages
      .filter((message) =>
        message.subtype === "thread_broadcast"
        && message.thread_ts === normalizedThreadTs
        && message.ts !== normalizedThreadTs
        && message.user
      )
      .map((message) => ({
        channelId: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
        threadTs: normalizedThreadTs,
        ts: message.ts,
        userId: message.user!,
        text: message.text,
      }));
    return selectAuthorizedSlackDecision({
      channelId: this.config.PRODUCT_FEEDBACK_SLACK_CHANNEL_ID,
      threadTs: normalizedThreadTs,
      allowedUserIds: this.config.PRODUCT_FEEDBACK_SLACK_ALLOWED_REVIEWER_IDS,
      replies: broadcastReplies,
    });
  }
}
