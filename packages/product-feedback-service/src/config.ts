import { z } from "zod";

const httpsUrl = z.string().url().transform((value, ctx) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    ctx.addIssue({ code: "custom", message: "must be an HTTPS URL without embedded credentials" });
    return z.NEVER;
  }
  return parsed.toString().replace(/\/$/, "");
});

const paperclipApiUrl = z.string().url().transform((value, ctx) => {
  const parsed = new URL(value);
  const isLoopback = parsed.hostname === "localhost"
    || parsed.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback))
  ) {
    ctx.addIssue({
      code: "custom",
      message: "must be HTTPS, or loopback HTTP, without credentials, query, or fragment",
    });
    return z.NEVER;
  }
  return parsed.toString().replace(/\/$/, "");
});

const baseSchema = z.object({
  PRODUCT_FEEDBACK_DATABASE_URL: z.string().min(1),
  PRODUCT_FEEDBACK_CONTACT_ENCRYPTION_KEY: z.string().min(1).transform((value, ctx) => {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32) {
      ctx.addIssue({ code: "custom", message: "must decode to exactly 32 bytes" });
      return z.NEVER;
    }
    return decoded;
  }),
}).passthrough();

export const gatewayConfigSchema = baseSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET: z.string().min(32),
  PRODUCT_FEEDBACK_ISSUER_ID: z.string().min(1).max(100),
  PRODUCT_FEEDBACK_ISSUER_SECRET: z.string().min(32),
  PRODUCT_FEEDBACK_INSTALLATION_REF: z.string().min(1).max(200),
  PRODUCT_FEEDBACK_SUBMISSION_MODE: z.enum(["local_validation", "production_feedback"]),
  PRODUCT_FEEDBACK_VALIDATION_RUN_ID: z.string().min(1).max(200).optional(),
  PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT: z.string().datetime().optional(),
  PRODUCT_FEEDBACK_POSTHOG_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  PRODUCT_FEEDBACK_POSTHOG_SURVEY_ID: z.string().min(1).max(200),
  PRODUCT_FEEDBACK_POSTHOG_QUESTION_ID: z.string().min(1).max(200),
  PRODUCT_FEEDBACK_ASANA_PROJECT_GID: z.string().regex(/^\d+$/),
  PRODUCT_FEEDBACK_ASANA_WEBHOOK_REF: z.string().min(32).max(200),
  PRODUCT_FEEDBACK_PUBLIC_BASE_URL: httpsUrl.optional(),
}).superRefine((value, ctx) => {
  if (value.PRODUCT_FEEDBACK_SUBMISSION_MODE === "local_validation") {
    if (!value.PRODUCT_FEEDBACK_VALIDATION_RUN_ID) {
      ctx.addIssue({ code: "custom", path: ["PRODUCT_FEEDBACK_VALIDATION_RUN_ID"], message: "required in local validation mode" });
    }
    if (!value.PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT) {
      ctx.addIssue({ code: "custom", path: ["PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT"], message: "required in local validation mode" });
    }
  } else if (value.PRODUCT_FEEDBACK_VALIDATION_RUN_ID || value.PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT) {
    ctx.addIssue({ code: "custom", path: ["PRODUCT_FEEDBACK_SUBMISSION_MODE"], message: "validation fields are forbidden in production mode" });
  }
});

export const workerConfigSchema = baseSchema.extend({
  PRODUCT_FEEDBACK_ASANA_ACCESS_TOKEN: z.string().min(20),
  PRODUCT_FEEDBACK_ASANA_PROJECT_GID: z.string().regex(/^\d+$/),
  PRODUCT_FEEDBACK_ASANA_VALIDATION_SECTION_GID: z.string().regex(/^\d+$/),
  PRODUCT_FEEDBACK_ASANA_NEW_SECTION_GID: z.string().regex(/^\d+$/),
  PRODUCT_FEEDBACK_ASANA_CUSTOM_FIELDS_JSON: z.string().default("{}").transform((value, ctx) => {
    try {
      return z.record(z.string(), z.string()).parse(JSON.parse(value));
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON object containing custom field GID mappings" });
      return z.NEVER;
    }
  }),
  PRODUCT_FEEDBACK_ASANA_API_BASE_URL: httpsUrl.default("https://app.asana.com/api/1.0"),
});

export const paperclipTriageConfigSchema = z.object({
  PRODUCT_FEEDBACK_PAPERCLIP_API_URL: paperclipApiUrl,
  PRODUCT_FEEDBACK_PAPERCLIP_API_KEY: z.string().min(1).optional(),
  PRODUCT_FEEDBACK_PAPERCLIP_COMPANY_ID: z.string().guid(),
  PRODUCT_FEEDBACK_PAPERCLIP_TRIAGE_AGENT_ID: z.string().guid(),
  PRODUCT_FEEDBACK_PAPERCLIP_PROJECT_ID: z.string().guid().optional(),
  PRODUCT_FEEDBACK_PAPERCLIP_GOAL_ID: z.string().guid().optional(),
  PRODUCT_FEEDBACK_PAPERCLIP_PARENT_ISSUE_ID: z.string().guid().optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.PRODUCT_FEEDBACK_PAPERCLIP_PROJECT_ID && !value.PRODUCT_FEEDBACK_PAPERCLIP_PARENT_ISSUE_ID) {
    ctx.addIssue({
      code: "custom",
      path: ["PRODUCT_FEEDBACK_PAPERCLIP_PROJECT_ID"],
      message: "a project or parent issue boundary is required",
    });
  }
});

export const slackHumanGateConfigSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-").min(20),
  PRODUCT_FEEDBACK_SLACK_TEAM_ID: z.string().regex(/^T[A-Z0-9]+$/),
  PRODUCT_FEEDBACK_SLACK_CHANNEL_ID: z.string().regex(/^C[A-Z0-9]+$/),
  PRODUCT_FEEDBACK_SLACK_CHANNEL_NAME: z.string().regex(/^[a-z0-9-]+$/).default("in-product-feedback"),
  PRODUCT_FEEDBACK_PAPERCLIP_REVIEW_BASE_URL: z.string().url().transform((value, ctx) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/") {
      ctx.addIssue({ code: "custom", message: "must be an http(s) origin without credentials or a path" });
      return z.NEVER;
    }
    return url.origin;
  }),
  PRODUCT_FEEDBACK_SLACK_ALLOWED_REVIEWER_IDS: z.string().transform((value, ctx) => {
    const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.some((id) => !/^U[A-Z0-9]+$/.test(id))) {
      ctx.addIssue({ code: "custom", message: "must contain one or more comma-separated Slack user IDs" });
      return z.NEVER;
    }
    return ids;
  }),
}).passthrough();

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type PaperclipTriageConfig = z.infer<typeof paperclipTriageConfigSchema>;
export type SlackHumanGateConfig = z.infer<typeof slackHumanGateConfigSchema>;

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return gatewayConfigSchema.parse(env);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerConfigSchema.parse(env);
}

export function loadPaperclipTriageConfig(env: NodeJS.ProcessEnv = process.env): PaperclipTriageConfig {
  return paperclipTriageConfigSchema.parse(env);
}

export function loadSlackHumanGateConfig(env: NodeJS.ProcessEnv = process.env): SlackHumanGateConfig {
  return slackHumanGateConfigSchema.parse(env);
}
