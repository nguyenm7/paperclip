import { z } from "zod";
import { sha256 } from "./security.js";

const SLACK_TEXT_LIMIT = 700;
const SLACK_SUMMARY_LIMIT = 1_500;
const slackTimestampSchema = z.string().regex(/^\d{10,}\.\d{6}$/);

export const feedbackCategorySchema = z.enum(["bug", "request", "idea", "needs_info"]);
export const feedbackDecisionActionSchema = z.enum([
  "approve",
  "revise",
  "needs_info",
  "defer",
  "decline",
]);

export const slackTriageRecommendationSchema = z.object({
  policyVersion: z.string().trim().min(1).max(100),
  submissionId: z.string().trim().min(1).max(200),
  asanaTaskGid: z.string().regex(/^\d+$/),
  paperclipIssueIdentifier: z.string().trim().min(1).max(100),
  paperclipIssueUrl: z.string().url().max(2_000),
  feedbackExcerpt: z.string().trim().min(1).max(5_000),
  category: feedbackCategorySchema,
  confidence: z.enum(["low", "medium", "high"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  userImpact: z.string().trim().min(1).max(1_000),
  duplicateAssessment: z.string().trim().min(1).max(1_000),
  recommendedAction: z.string().trim().min(1).max(1_000),
}).strict();

export type SlackTriageRecommendation = z.infer<typeof slackTriageRecommendationSchema>;

export const slackReviewNotificationSchema = z.object({
  policyVersion: z.string().trim().min(1).max(100),
  submissionId: z.string().trim().min(1).max(200),
  threadTs: slackTimestampSchema,
  stage: z.enum(["task_review", "pull_request_review"]),
  paperclipIssueIdentifier: z.string().trim().min(1).max(100),
  paperclipIssueUrl: z.string().url().max(2_000),
  reviewTargetLabel: z.string().trim().min(1).max(200),
  reviewUrl: z.string().url().max(2_000),
  summary: z.string().trim().min(1).max(1_000),
}).strict().superRefine((value, ctx) => {
  const issueUrl = new URL(value.paperclipIssueUrl);
  const reviewUrl = new URL(value.reviewUrl);
  if (!["http:", "https:"].includes(issueUrl.protocol)) {
    ctx.addIssue({ code: "custom", path: ["paperclipIssueUrl"], message: "must use http or https" });
  }
  if (value.stage === "task_review") {
    if (reviewUrl.origin !== issueUrl.origin || !reviewUrl.pathname.includes("/issues/")) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewUrl"],
        message: "task review URL must be a Paperclip issue URL on the same origin",
      });
    }
    return;
  }
  if (reviewUrl.protocol !== "https:"
    || reviewUrl.hostname !== "github.com"
    || !/^\/paperclipai\/paperclip\/pull\/\d+\/?$/.test(reviewUrl.pathname)) {
    ctx.addIssue({
      code: "custom",
      path: ["reviewUrl"],
      message: "pull request review URL must target paperclipai/paperclip on GitHub",
    });
  }
});

export type SlackReviewNotification = z.infer<typeof slackReviewNotificationSchema>;

export const slackThreadReplySchema = z.object({
  channelId: z.string().trim().min(1).max(100),
  threadTs: slackTimestampSchema,
  ts: slackTimestampSchema,
  userId: z.string().trim().min(1).max(100),
  text: z.string().max(10_000),
}).strict();

export type SlackThreadReply = z.infer<typeof slackThreadReplySchema>;

export type ParsedSlackDecision = {
  action: z.infer<typeof feedbackDecisionActionSchema>;
  category: z.infer<typeof feedbackCategorySchema> | null;
  revisedAction: string | null;
  rationale: string;
  supersedesTs: string | null;
};

export type AcceptedSlackDecision = ParsedSlackDecision & {
  channelId: string;
  threadTs: string;
  decisionTs: string;
  actorUserId: string;
  contentHash: string;
};

export type SlackDecisionSelection =
  | { status: "pending"; rejectedDecisionReplies: number }
  | { status: "conflict"; decisionTimestamps: string[] }
  | { status: "accepted"; decision: AcceptedSlackDecision };

export const triageLearningExampleV1Schema = z.object({
  version: z.literal(1),
  exampleId: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.string().trim().min(1).max(100),
  capturedAt: z.string().datetime(),
  provenance: z.object({
    channelId: z.string().trim().min(1).max(100),
    threadTs: slackTimestampSchema,
    decisionTs: slackTimestampSchema,
    actorUserId: z.string().trim().min(1).max(100),
    decisionContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  originalRecommendation: z.object({
    submissionId: z.string().trim().min(1).max(200),
    paperclipIssueIdentifier: z.string().trim().min(1).max(100),
    category: feedbackCategorySchema,
    confidence: z.enum(["low", "medium", "high"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    recommendedAction: z.string().trim().min(1).max(1_000),
  }).strict(),
  acceptedDecision: z.object({
    action: feedbackDecisionActionSchema,
    category: feedbackCategorySchema.nullable(),
    revisedAction: z.string().trim().min(1).max(1_000).nullable(),
    rationale: z.string().trim().min(1).max(1_500),
  }).strict(),
  discussionSummary: z.string().trim().min(1).max(SLACK_SUMMARY_LIMIT),
}).strict();

export type TriageLearningExampleV1 = z.infer<typeof triageLearningExampleV1Schema>;

function sanitizeUntrustedText(value: string, limit = SLACK_TEXT_LIMIT): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[redacted email]")
    .replace(/\bhttps?:\/\/\S+/gi, "[link omitted]")
    .replace(/\b(?:xox[baprs]-|gh[pousr]_|sk-|phx_)[A-Za-z0-9_-]{8,}\b/g, "[redacted credential]")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function quoteSlack(value: string): string {
  return sanitizeUntrustedText(value)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function buildSlackHumanGateMessage(raw: unknown): string {
  const input = slackTriageRecommendationSchema.parse(raw);
  return [
    ":paperclip: *New product feedback — awaiting human decision*",
    "",
    "*Feedback excerpt* (untrusted, links and contact data removed)",
    quoteSlack(input.feedbackExcerpt),
    "",
    "*Agent triage*",
    `• Category: \`${input.category}\` (${input.confidence} confidence)`,
    `• Severity: \`${input.severity}\``,
    `• User impact: ${sanitizeUntrustedText(input.userImpact)}`,
    `• Duplicate assessment: ${sanitizeUntrustedText(input.duplicateAssessment)}`,
    `• Recommended action: ${sanitizeUntrustedText(input.recommendedAction)}`,
    `• Policy version: \`${sanitizeUntrustedText(input.policyVersion, 100)}\``,
    "",
    "Discuss in this thread. Discussion is advisory; no downstream work starts until an allowlisted teammate posts one valid decision and checks *Also send to channel*:",
    "```",
    "DECISION: approve | revise | needs_info | defer | decline",
    "CATEGORY: bug | request | idea | needs_info   # required for revise",
    "ACTION: <revised action>                       # required for revise",
    "RATIONALE: <why the team chose this>",
    "```",
    "Only the broadcast structured reply is authoritative in the bot-token demo path. Other thread replies remain discussion context.",
    "",
    `<${input.paperclipIssueUrl}|Paperclip ${input.paperclipIssueIdentifier}> · <https://app.asana.com/0/0/${input.asanaTaskGid}|Asana feedback> · submission \`${sanitizeUntrustedText(input.submissionId, 200)}\``,
  ].join("\n");
}

export function buildSlackReviewNotification(
  raw: unknown,
  allowedReviewerIds: Iterable<string>,
): string {
  const input = slackReviewNotificationSchema.parse(raw);
  const reviewers = [...new Set(allowedReviewerIds)]
    .filter((id) => /^U[A-Z0-9]+$/.test(id))
    .map((id) => `<@${id}>`)
    .join(" ");
  if (!reviewers) throw new Error("slack_review_notification_reviewer_required");

  const isPullRequest = input.stage === "pull_request_review";
  const heading = isPullRequest
    ? ":paperclip: *Pull request ready for human review*"
    : ":paperclip: *Task ready for human review*";
  const boundary = isPullRequest
    ? "Review and merge remain human-only. This message does not approve or merge the PR."
    : "Accept or request changes in Paperclip. This message does not resolve the human review gate.";
  return [
    heading,
    "",
    `${reviewers} The feedback workflow has reached its next governed review point.`,
    `• Review target: ${sanitizeUntrustedText(input.reviewTargetLabel, 200)}`,
    `• Summary: ${sanitizeUntrustedText(input.summary, 1_000)}`,
    `• Policy version: \`${sanitizeUntrustedText(input.policyVersion, 100)}\``,
    "",
    `<${input.reviewUrl}|Open review> · <${input.paperclipIssueUrl}|Paperclip ${input.paperclipIssueIdentifier}> · submission \`${sanitizeUntrustedText(input.submissionId, 200)}\``,
    "",
    boundary,
    "Discussion in this Slack thread is context only; the recorded Paperclip or GitHub review remains authoritative.",
  ].join("\n");
}

function parseDecisionText(text: string): ParsedSlackDecision | null {
  const fields = new Map<string, string>();
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^([A-Z_]+):\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    const key = match[1]!;
    if (!["DECISION", "CATEGORY", "ACTION", "RATIONALE", "SUPERSEDES"].includes(key)) continue;
    if (fields.has(key)) return null;
    fields.set(key, match[2]!);
  }

  const action = feedbackDecisionActionSchema.safeParse(fields.get("DECISION"));
  if (!action.success) return null;
  const rationale = sanitizeUntrustedText(fields.get("RATIONALE") ?? "", SLACK_SUMMARY_LIMIT);
  if (!rationale) return null;

  const categoryValue = fields.get("CATEGORY");
  const category = categoryValue ? feedbackCategorySchema.safeParse(categoryValue) : null;
  if (categoryValue && !category?.success) return null;
  const revisedAction = sanitizeUntrustedText(fields.get("ACTION") ?? "", 1_000) || null;
  if (action.data === "revise" && (!category?.success || !revisedAction)) return null;

  const supersedesValue = fields.get("SUPERSEDES");
  const supersedes = supersedesValue ? slackTimestampSchema.safeParse(supersedesValue) : null;
  if (supersedesValue && !supersedes?.success) return null;

  return {
    action: action.data,
    category: category?.success ? category.data : null,
    revisedAction,
    rationale,
    supersedesTs: supersedes?.success ? supersedes.data : null,
  };
}

function compareSlackTimestamp(left: string, right: string): number {
  const [leftSeconds, leftMicros] = left.split(".");
  const [rightSeconds, rightMicros] = right.split(".");
  return BigInt(leftSeconds!) === BigInt(rightSeconds!)
    ? Number(BigInt(leftMicros!) - BigInt(rightMicros!))
    : BigInt(leftSeconds!) < BigInt(rightSeconds!) ? -1 : 1;
}

export function selectAuthorizedSlackDecision(input: {
  channelId: string;
  threadTs: string;
  allowedUserIds: Iterable<string>;
  replies: unknown[];
}): SlackDecisionSelection {
  const threadTs = slackTimestampSchema.parse(input.threadTs);
  const allowed = new Set(input.allowedUserIds);
  const candidates: AcceptedSlackDecision[] = [];
  let rejectedDecisionReplies = 0;

  for (const rawReply of input.replies) {
    const parsedReply = slackThreadReplySchema.safeParse(rawReply);
    if (!parsedReply.success) continue;
    const reply = parsedReply.data;
    if (reply.channelId !== input.channelId || reply.threadTs !== threadTs) continue;
    const decision = parseDecisionText(reply.text);
    if (!decision) {
      if (/^DECISION:/m.test(reply.text)) rejectedDecisionReplies += 1;
      continue;
    }
    if (!allowed.has(reply.userId)) {
      rejectedDecisionReplies += 1;
      continue;
    }
    candidates.push({
      ...decision,
      channelId: reply.channelId,
      threadTs: reply.threadTs,
      decisionTs: reply.ts,
      actorUserId: reply.userId,
      contentHash: sha256(reply.text),
    });
  }

  candidates.sort((left, right) => compareSlackTimestamp(left.decisionTs, right.decisionTs));
  if (candidates.length === 0) return { status: "pending", rejectedDecisionReplies };

  let active = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.supersedesTs !== active.decisionTs) {
      return { status: "conflict", decisionTimestamps: candidates.map((item) => item.decisionTs) };
    }
    active = candidate;
  }
  return { status: "accepted", decision: active };
}

export function buildTriageLearningExample(input: {
  recommendation: unknown;
  decision: AcceptedSlackDecision;
  discussionSummary: string;
  capturedAt?: Date;
}): TriageLearningExampleV1 {
  const recommendation = slackTriageRecommendationSchema.parse(input.recommendation);
  const discussionSummary = sanitizeUntrustedText(input.discussionSummary, SLACK_SUMMARY_LIMIT);
  if (!discussionSummary) throw new Error("discussion_summary_required");
  const seed = JSON.stringify({
    submissionId: recommendation.submissionId,
    channelId: input.decision.channelId,
    threadTs: input.decision.threadTs,
    decisionTs: input.decision.decisionTs,
    decisionContentHash: input.decision.contentHash,
  });
  return triageLearningExampleV1Schema.parse({
    version: 1,
    exampleId: sha256(seed),
    policyVersion: recommendation.policyVersion,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    provenance: {
      channelId: input.decision.channelId,
      threadTs: input.decision.threadTs,
      decisionTs: input.decision.decisionTs,
      actorUserId: input.decision.actorUserId,
      decisionContentHash: input.decision.contentHash,
    },
    originalRecommendation: {
      submissionId: recommendation.submissionId,
      paperclipIssueIdentifier: recommendation.paperclipIssueIdentifier,
      category: recommendation.category,
      confidence: recommendation.confidence,
      severity: recommendation.severity,
      recommendedAction: sanitizeUntrustedText(recommendation.recommendedAction, 1_000),
    },
    acceptedDecision: {
      action: input.decision.action,
      category: input.decision.category,
      revisedAction: input.decision.revisedAction,
      rationale: input.decision.rationale,
    },
    discussionSummary,
  });
}
