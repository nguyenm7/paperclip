import { z } from "zod";

const standardWebhookSecret = z.string().startsWith("whsec_").refine((value) => {
  const encoded = value.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  return Buffer.from(encoded, "base64").length >= 32;
}, "must contain at least 32 bytes of base64-encoded secret material");

const baseSchema = z.object({
  PRODUCT_FEEDBACK_DATABASE_URL: z.string().min(1),
  PRODUCT_FEEDBACK_CONTACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
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
  PRODUCT_FEEDBACK_POSTHOG_WEBHOOK_SECRET: standardWebhookSecret,
  PRODUCT_FEEDBACK_POSTHOG_SURVEY_ID: z.string().min(1).max(200),
  PRODUCT_FEEDBACK_POSTHOG_QUESTION_ID: z.string().min(1).max(200),
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
  if (value.PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET === value.PRODUCT_FEEDBACK_ISSUER_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET"],
      message: "must be distinct from the issuer secret",
    });
  }
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return gatewayConfigSchema.parse(env);
}
