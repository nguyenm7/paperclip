import { z } from "zod";
import {
  PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT,
  PRODUCT_FEEDBACK_MAX_LENGTH,
  PRODUCT_FEEDBACK_SCHEMA_VERSION,
  productFeedbackGrantRequestSchema,
} from "@paperclipai/shared";

export const submissionModeSchema = z.enum(["local_validation", "production_feedback"]);

export const brokerGrantRequestSchema = productFeedbackGrantRequestSchema;

export const grantClaimsSchema = z.object({
  v: z.literal(1),
  jti: z.string().uuid(),
  submissionId: z.string().uuid(),
  installationRef: z.string().min(1).max(200),
  submissionMode: submissionModeSchema,
  validationRunId: z.string().min(1).max(200).optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.submissionMode === "local_validation" && !value.validationRunId) {
    ctx.addIssue({ code: "custom", message: "validationRunId is required for local validation", path: ["validationRunId"] });
  }
  if (value.submissionMode === "production_feedback" && value.validationRunId) {
    ctx.addIssue({ code: "custom", message: "validationRunId is forbidden for production feedback", path: ["validationRunId"] });
  }
});

export const productFeedbackDiagnosticSchema = z.object({
  code: z.string().min(1).max(100),
  component: z.string().min(1).max(100),
  routeTemplate: z.string().min(1).max(300),
  timestamp: z.string().datetime(),
}).strict();

export const posthogFeedbackDeliverySchema = z.object({
  event: z.literal("survey sent"),
  distinct_id: z.string().uuid(),
  timestamp: z.string().datetime().optional(),
  survey_id: z.string().min(1).max(200),
  question_id: z.string().min(1).max(200),
  schema_version: z.literal(PRODUCT_FEEDBACK_SCHEMA_VERSION),
  feedback: z.string().trim().min(1).max(PRODUCT_FEEDBACK_MAX_LENGTH),
  submission_id: z.string().uuid(),
  grant_token: z.string().min(1).max(4096),
  submission_mode: submissionModeSchema,
  validation_run_id: z.string().min(1).max(200).nullable(),
  installation_ref: z.string().min(1).max(200),
  client_timestamp: z.string().datetime(),
  route_template: z.string().min(1).max(300),
  app_version: z.string().max(100).nullable(),
  deployment_mode: z.enum(["local_trusted", "authenticated"]),
  browser: z.string().min(1).max(200),
  operating_system: z.string().min(1).max(200),
  diagnostics: z.array(productFeedbackDiagnosticSchema).max(PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT),
}).strict();

export type GrantClaims = z.infer<typeof grantClaimsSchema>;
export type PosthogFeedbackDelivery = z.infer<typeof posthogFeedbackDeliverySchema>;
