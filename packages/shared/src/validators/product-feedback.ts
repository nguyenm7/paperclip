import { z } from "zod";
import {
  PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT,
  PRODUCT_FEEDBACK_MAX_LENGTH,
} from "../types/product-feedback.js";

export const productFeedbackCapabilitySchema = z.object({
  enabled: z.boolean(),
  provider: z.literal("posthog"),
  posthog: z.object({
    apiHost: z.string().url().refine((value) => {
      const parsed = new URL(value);
      return parsed.protocol === "https:"
        && !parsed.username
        && !parsed.password
        && (parsed.host === "us.i.posthog.com" || parsed.host === "eu.i.posthog.com");
    }, "must be an approved PostHog ingest origin"),
    projectToken: z.string().regex(/^phc_[A-Za-z0-9_-]+$/),
    surveyId: z.string().min(1),
    questionId: z.string().min(1),
  }).strict().optional(),
  limits: z.object({
    feedbackMaxLength: z.number().int().positive().max(PRODUCT_FEEDBACK_MAX_LENGTH),
    diagnosticCount: z.number().int().nonnegative().max(PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT),
  }).strict(),
}).strict();

const productFeedbackContactRequestSchema = z.object({
  submissionId: z.string().uuid(),
  followUpConsent: z.boolean(),
  reporterEmail: z.string().trim().email().max(320).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.followUpConsent && value.reporterEmail === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reporterEmail is required when followUpConsent is enabled",
      path: ["reporterEmail"],
    });
  } else if (!value.followUpConsent && value.reporterEmail !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reporterEmail requires followUpConsent",
      path: ["reporterEmail"],
    });
  }
});

export const productFeedbackGrantRequestSchema = z.object({
  companyId: z.string().uuid(),
  submissionId: z.string().uuid(),
  followUpConsent: z.boolean(),
  reporterEmail: z.string().trim().email().max(320).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.followUpConsent && value.reporterEmail === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reporterEmail is required when followUpConsent is enabled",
      path: ["reporterEmail"],
    });
  } else if (!value.followUpConsent && value.reporterEmail !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reporterEmail requires followUpConsent",
      path: ["reporterEmail"],
    });
  }
});

export const productFeedbackBrokerRequestSchema = productFeedbackContactRequestSchema;

export const productFeedbackGrantSchema = z.object({
  grantToken: z.string().min(1).max(4096),
  submissionMode: z.enum(["local_validation", "production_feedback"]),
  validationRunId: z.string().min(1).max(200).optional(),
  opaqueInstallationId: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
});

export const productFeedbackBodySchema = z.string().trim().min(1).max(PRODUCT_FEEDBACK_MAX_LENGTH);

export type ProductFeedbackGrantRequestInput = z.infer<typeof productFeedbackGrantRequestSchema>;
