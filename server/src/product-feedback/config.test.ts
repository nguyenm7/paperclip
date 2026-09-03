import { describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "./config.js";

function validConfig() {
  return {
    PRODUCT_FEEDBACK_DATABASE_URL: "postgres://feedback:test@database.example/feedback",
    PRODUCT_FEEDBACK_CONTACT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET: "grant-secret-that-is-long-enough-for-tests",
    PRODUCT_FEEDBACK_ISSUER_ID: "production-paperclip",
    PRODUCT_FEEDBACK_ISSUER_SECRET: "issuer-secret-that-is-long-enough-for-tests",
    PRODUCT_FEEDBACK_INSTALLATION_REF: "opaque-installation",
    PRODUCT_FEEDBACK_SUBMISSION_MODE: "production_feedback",
    PRODUCT_FEEDBACK_POSTHOG_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 9).toString("base64")}`,
    PRODUCT_FEEDBACK_POSTHOG_SURVEY_ID: "survey-id",
    PRODUCT_FEEDBACK_POSTHOG_QUESTION_ID: "question-id",
  };
}

describe("product feedback gateway configuration", () => {
  it("loads production mode with bounded retention", () => {
    expect(gatewayConfigSchema.parse(validConfig())).toMatchObject({
      PRODUCT_FEEDBACK_SUBMISSION_MODE: "production_feedback",
      PRODUCT_FEEDBACK_CONTACT_RETENTION_DAYS: 90,
    });
  });

  it("rejects weak webhook secrets and shared-purpose HMAC secrets", () => {
    expect(() => gatewayConfigSchema.parse({
      ...validConfig(),
      PRODUCT_FEEDBACK_POSTHOG_WEBHOOK_SECRET: "whsec_d2Vhaw==",
    })).toThrow("at least 32 bytes");

    const sharedSecret = "shared-secret-that-is-long-enough-for-tests";
    expect(() => gatewayConfigSchema.parse({
      ...validConfig(),
      PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET: sharedSecret,
      PRODUCT_FEEDBACK_ISSUER_SECRET: sharedSecret,
    })).toThrow("must be distinct from the issuer secret");
  });

  it("forbids canary fields in production mode", () => {
    expect(() => gatewayConfigSchema.parse({
      ...validConfig(),
      PRODUCT_FEEDBACK_VALIDATION_RUN_ID: "stale-canary",
      PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
    })).toThrow("validation fields are forbidden in production mode");
  });
});
