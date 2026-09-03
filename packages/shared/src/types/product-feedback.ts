export const PRODUCT_FEEDBACK_MAX_LENGTH = 5_000;
export const PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT = 5;
export const PRODUCT_FEEDBACK_SCHEMA_VERSION = "paperclip-product-feedback-v1";

export interface ProductFeedbackCapability {
  enabled: boolean;
  provider: "posthog";
  posthog?: {
    apiHost: string;
    projectToken: string;
    surveyId: string;
    questionId: string;
  };
  limits: {
    feedbackMaxLength: number;
    diagnosticCount: number;
  };
}

export const DISABLED_PRODUCT_FEEDBACK_CAPABILITY: ProductFeedbackCapability = {
  enabled: false,
  provider: "posthog",
  limits: {
    feedbackMaxLength: PRODUCT_FEEDBACK_MAX_LENGTH,
    diagnosticCount: PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT,
  },
};

export interface ProductFeedbackDiagnostic {
  code: string;
  component: string;
  routeTemplate: string;
  timestamp: string;
}

export interface ProductFeedbackGrantRequest {
  companyId: string;
  submissionId: string;
  followUpConsent: boolean;
  reporterEmail?: string;
}

export type ProductFeedbackBrokerRequest = Omit<ProductFeedbackGrantRequest, "companyId">;

export interface ProductFeedbackGrant {
  grantToken: string;
  submissionMode: "local_validation" | "production_feedback";
  validationRunId?: string;
  opaqueInstallationId: string;
  expiresAt: string;
}
