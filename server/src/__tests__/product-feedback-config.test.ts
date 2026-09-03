import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

const variables = [
  "PAPERCLIP_PRODUCT_FEEDBACK_ENABLED",
  "PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST",
  "PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN",
  "PAPERCLIP_PRODUCT_FEEDBACK_SURVEY_ID",
  "PAPERCLIP_PRODUCT_FEEDBACK_QUESTION_ID",
  "PAPERCLIP_PRODUCT_FEEDBACK_DELIVERY_MODE",
  "PAPERCLIP_PRODUCT_FEEDBACK_VALIDATION_RUN_ID",
  "PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ENDPOINT",
  "PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ISSUER_ID",
  "PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ISSUER_SECRET",
] as const;

function clearProductFeedbackEnvironment() {
  for (const variable of variables) vi.stubEnv(variable, undefined);
}

describe("product feedback config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is disabled by default", () => {
    clearProductFeedbackEnvironment();

    expect(loadConfig().productFeedback).toEqual({
      enabled: false,
      provider: "posthog",
      limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
    });
  });

  it("builds the public capability from complete operator configuration", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST", "https://us.i.posthog.com/");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN", "phc_public_test_token");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_SURVEY_ID", "survey-123");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_QUESTION_ID", "question-456");

    expect(loadConfig().productFeedback).toEqual({
      enabled: true,
      provider: "posthog",
      posthog: {
        apiHost: "https://us.i.posthog.com",
        projectToken: "phc_public_test_token",
        surveyId: "survey-123",
        questionId: "question-456",
      },
      limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
    });
  });

  it("refuses enabled configuration without every survey field", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "true");

    expect(() => loadConfig()).toThrow(
      "Product feedback is enabled but its PostHog API host, project token, survey ID, or question ID is missing",
    );
  });

  it("advertises an explicitly bounded direct PostHog validation path", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST", "https://us.i.posthog.com");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN", "phc_public_test_token");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_SURVEY_ID", "survey-123");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_QUESTION_ID", "question-456");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_DELIVERY_MODE", "posthog_direct");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_VALIDATION_RUN_ID", "validation-run-1");

    expect(loadConfig().productFeedback.posthog?.directDelivery).toEqual({
      submissionMode: "local_validation",
      validationRunId: "validation-run-1",
    });
  });

  it("requires a validation run id for direct delivery", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST", "https://us.i.posthog.com");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN", "phc_public_test_token");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_SURVEY_ID", "survey-123");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_QUESTION_ID", "question-456");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_DELIVERY_MODE", "posthog_direct");

    expect(() => loadConfig()).toThrow("productFeedback.validationRunId is required for posthog_direct delivery");
  });

  it("refuses a non-HTTPS capture host", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST", "http://127.0.0.1:3001");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN", "phc_public_test_token");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_SURVEY_ID", "survey-123");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_QUESTION_ID", "question-456");

    expect(() => loadConfig()).toThrow("productFeedback.posthogApiHost must use https");
  });

  it("refuses capture hosts with embedded credentials", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST", "https://user:password@us.i.posthog.com");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_PROJECT_TOKEN", "phc_public_test_token");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_SURVEY_ID", "survey-123");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_QUESTION_ID", "question-456");

    expect(() => loadConfig()).toThrow("productFeedback.posthogApiHost must not contain credentials");
  });

  it("ignores stale vendor configuration while the capability is disabled", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_ENABLED", "false");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_POSTHOG_API_HOST", "http://stale.invalid");

    expect(loadConfig().productFeedback.enabled).toBe(false);
  });

  it("loads an HTTPS server-only broker configuration", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ENDPOINT", "https://feedback.paperclip.ing/v1/grants");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ISSUER_ID", "paperclip-local-canary");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ISSUER_SECRET", "issuer-secret-that-is-long-enough-for-tests");

    expect(loadConfig().productFeedbackBroker).toEqual({
      endpoint: "https://feedback.paperclip.ing/v1/grants",
      issuerId: "paperclip-local-canary",
      issuerSecret: "issuer-secret-that-is-long-enough-for-tests",
    });
  });

  it("rejects partial or insecure broker configuration", () => {
    clearProductFeedbackEnvironment();
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ENDPOINT", "https://feedback.paperclip.ing/v1/grants");
    expect(() => loadConfig()).toThrow("must be configured together");

    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ISSUER_ID", "paperclip-local-canary");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ISSUER_SECRET", "issuer-secret-that-is-long-enough-for-tests");
    vi.stubEnv("PAPERCLIP_PRODUCT_FEEDBACK_BROKER_ENDPOINT", "http://127.0.0.1:8080/v1/grants");
    expect(() => loadConfig()).toThrow("brokerEndpoint must use https");
  });
});
