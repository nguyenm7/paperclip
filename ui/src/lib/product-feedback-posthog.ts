import {
  PRODUCT_FEEDBACK_SCHEMA_VERSION,
  type DeploymentMode,
  type ProductFeedbackCapability,
  type ProductFeedbackDiagnostic,
  type ProductFeedbackGrant,
} from "@paperclipai/shared";

export type ProductFeedbackSurveyEvent = "survey shown" | "survey dismissed" | "survey sent";

export interface ProductFeedbackEventContext {
  capability: ProductFeedbackCapability;
  distinctId: string;
  routeTemplate: string;
  appVersion: string | null;
  deploymentMode: DeploymentMode;
  browser: string;
  operatingSystem: string;
}

export interface ProductFeedbackSubmissionContext extends ProductFeedbackEventContext {
  feedback: string;
  followUpConsent: boolean;
  grant?: ProductFeedbackGrant;
  diagnostics: ProductFeedbackDiagnostic[];
  clientTimestamp: string;
}

export type ProductFeedbackCapture = (
  event: ProductFeedbackSurveyEvent,
  context: ProductFeedbackEventContext | ProductFeedbackSubmissionContext,
) => Promise<void>;

export function buildProductFeedbackPosthogEvent(
  event: ProductFeedbackSurveyEvent,
  context: ProductFeedbackEventContext | ProductFeedbackSubmissionContext,
) {
  const posthog = context.capability.posthog;
  if (!context.capability.enabled || !posthog) {
    throw new Error("Product feedback is not configured");
  }

  const properties: Record<string, unknown> = {
    $survey_id: posthog.surveyId,
    $process_person_profile: false,
    paperclip_schema_version: PRODUCT_FEEDBACK_SCHEMA_VERSION,
    paperclip_route_template: context.routeTemplate,
    paperclip_app_version: context.appVersion,
    paperclip_deployment_mode: context.deploymentMode,
    paperclip_browser: context.browser,
    paperclip_operating_system: context.operatingSystem,
  };

  if (event === "survey sent") {
    const submission = context as ProductFeedbackSubmissionContext;
    const directDelivery = posthog.directDelivery;
    if (!directDelivery && !submission.grant) {
      throw new Error("Brokered product feedback requires a submission grant");
    }
    properties[`$survey_response_${posthog.questionId}`] = submission.feedback;
    properties.$survey_questions = [{
      id: posthog.questionId,
      question: "What could Paperclip do better?",
    }];
    properties.paperclip_submission_id = submission.distinctId;
    properties.paperclip_delivery_mode = directDelivery ? "posthog_direct" : "brokered";
    properties.paperclip_submission_mode = directDelivery?.submissionMode ?? submission.grant!.submissionMode;
    properties.paperclip_validation_run_id = directDelivery?.validationRunId
      ?? submission.grant?.validationRunId
      ?? null;
    properties.paperclip_follow_up_consent = submission.followUpConsent;
    if (submission.grant) {
      properties.paperclip_submission_grant = submission.grant.grantToken;
      properties.paperclip_installation_ref = submission.grant.opaqueInstallationId;
    }
    properties.paperclip_client_timestamp = submission.clientTimestamp;
    properties.paperclip_diagnostics = submission.diagnostics;
  }

  return {
    api_key: posthog.projectToken,
    event,
    distinct_id: context.distinctId,
    properties,
  };
}

export const captureProductFeedbackPosthogEvent: ProductFeedbackCapture = async (
  event: ProductFeedbackSurveyEvent,
  context: ProductFeedbackEventContext | ProductFeedbackSubmissionContext,
) => {
  const posthog = context.capability.posthog;
  if (!posthog) throw new Error("Product feedback is not configured");
  const response = await fetch(`${posthog.apiHost}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildProductFeedbackPosthogEvent(event, context)),
    keepalive: event === "survey dismissed",
  });
  if (!response.ok) {
    throw new Error(`PostHog capture failed (${response.status})`);
  }
};
