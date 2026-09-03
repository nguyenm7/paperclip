import { describe, expect, it } from "vitest";
import type { ProductFeedbackCapability } from "@paperclipai/shared";
import { buildProductFeedbackPosthogEvent } from "./product-feedback-posthog";

const capability: ProductFeedbackCapability = {
  enabled: true,
  provider: "posthog",
  posthog: {
    apiHost: "https://us.i.posthog.com",
    projectToken: "phc_public_test_token",
    surveyId: "survey-123",
    questionId: "question-456",
  },
  limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
};

describe("buildProductFeedbackPosthogEvent", () => {
  it("builds the PostHog custom-survey contract without reporter identity", () => {
    const payload = buildProductFeedbackPosthogEvent("survey sent", {
      capability,
      distinctId: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
      routeTemplate: "/LOOA/issues/:task",
      appVersion: "2026.901.0",
      deploymentMode: "authenticated",
      browser: "Chrome 140",
      operatingSystem: "macOS 15",
      feedback: "A useful draft",
      followUpConsent: true,
      grant: {
        grantToken: "single-use-grant",
        submissionMode: "production_feedback",
        opaqueInstallationId: "installation-ref",
        expiresAt: "2026-09-02T00:00:00.000Z",
      },
      diagnostics: [{
        code: "request_failed",
        component: "issue_panel",
        routeTemplate: "/LOOA/issues/:task",
        timestamp: "2026-09-01T23:00:00.000Z",
      }],
      clientTimestamp: "2026-09-01T23:01:00.000Z",
    });

    expect(payload).toEqual({
      api_key: "phc_public_test_token",
      event: "survey sent",
      distinct_id: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
      properties: {
        $survey_id: "survey-123",
        $process_person_profile: false,
        paperclip_schema_version: "paperclip-product-feedback-v1",
        paperclip_route_template: "/LOOA/issues/:task",
        paperclip_app_version: "2026.901.0",
        paperclip_deployment_mode: "authenticated",
        paperclip_browser: "Chrome 140",
        paperclip_operating_system: "macOS 15",
        "$survey_response_question-456": "A useful draft",
        $survey_questions: [{ id: "question-456", question: "What could Paperclip do better?" }],
        paperclip_submission_id: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
        paperclip_delivery_mode: "brokered",
        paperclip_submission_grant: "single-use-grant",
        paperclip_submission_mode: "production_feedback",
        paperclip_validation_run_id: null,
        paperclip_follow_up_consent: true,
        paperclip_installation_ref: "installation-ref",
        paperclip_client_timestamp: "2026-09-01T23:01:00.000Z",
        paperclip_diagnostics: [{
          code: "request_failed",
          component: "issue_panel",
          routeTemplate: "/LOOA/issues/:task",
          timestamp: "2026-09-01T23:00:00.000Z",
        }],
      },
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("reporterEmail");
    expect(serialized).not.toContain("email");
  });

  it("builds a validation-only direct event without contact or grant material", () => {
    const directCapability: ProductFeedbackCapability = {
      ...capability,
      posthog: {
        ...capability.posthog!,
        directDelivery: {
          submissionMode: "local_validation",
          validationRunId: "looa-2103-direct-asana-2026-09-01",
        },
      },
    };

    const payload = buildProductFeedbackPosthogEvent("survey sent", {
      capability: directCapability,
      distinctId: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
      routeTemplate: "/LOOA/issues/:task",
      appVersion: "2026.901.0",
      deploymentMode: "local_trusted",
      browser: "Chrome 140",
      operatingSystem: "macOS 15",
      feedback: "Direct validation feedback",
      followUpConsent: true,
      diagnostics: [],
      clientTimestamp: "2026-09-01T23:01:00.000Z",
    });

    expect(payload.properties).toMatchObject({
      paperclip_delivery_mode: "posthog_direct",
      paperclip_submission_mode: "local_validation",
      paperclip_validation_run_id: "looa-2103-direct-asana-2026-09-01",
      paperclip_follow_up_consent: true,
    });
    expect(JSON.stringify(payload)).not.toContain("submission_grant");
    expect(JSON.stringify(payload)).not.toContain("installation_ref");
    expect(JSON.stringify(payload)).not.toContain("email");
  });

  it("keeps lifecycle events free of response and grant properties", () => {
    const payload = buildProductFeedbackPosthogEvent("survey shown", {
      capability,
      distinctId: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
      routeTemplate: "/LOOA/issues/:task",
      appVersion: null,
      deploymentMode: "local_trusted",
      browser: "Firefox 142",
      operatingSystem: "Linux",
    });

    expect(payload.event).toBe("survey shown");
    expect(payload.distinct_id).toBe("708db09f-1a29-4dd6-ad62-99b19b6902b4");
    expect(payload.properties).toMatchObject({
      $survey_id: "survey-123",
      $process_person_profile: false,
    });
    expect(JSON.stringify(payload)).not.toContain("$survey_response_");
    expect(JSON.stringify(payload)).not.toContain("submission_grant");
  });
});
