import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { createFeedbackGateway } from "./gateway.js";
import { MemoryFeedbackStore } from "./memory-store.js";
import { issuerSignature } from "./security.js";

const NOW = new Date("2026-09-02T02:00:00.000Z");
const ISSUER_SECRET = "issuer-secret-that-is-long-enough-for-tests";
const WEBHOOK_KEY = Buffer.from("posthog-standard-webhook-secret-32");

function config(): GatewayConfig {
  return {
    PORT: 8080,
    PRODUCT_FEEDBACK_DATABASE_URL: "postgres://unused",
    PRODUCT_FEEDBACK_CONTACT_ENCRYPTION_KEY: Buffer.alloc(32, 7),
    PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET: "grant-secret-that-is-long-enough-for-tests",
    PRODUCT_FEEDBACK_ISSUER_ID: "paperclip-local-canary",
    PRODUCT_FEEDBACK_ISSUER_SECRET: ISSUER_SECRET,
    PRODUCT_FEEDBACK_INSTALLATION_REF: "installation-test",
    PRODUCT_FEEDBACK_SUBMISSION_MODE: "local_validation",
    PRODUCT_FEEDBACK_VALIDATION_RUN_ID: "validation-run-1",
    PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT: "2026-09-02T03:00:00.000Z",
    PRODUCT_FEEDBACK_POSTHOG_WEBHOOK_SECRET: `whsec_${WEBHOOK_KEY.toString("base64")}`,
    PRODUCT_FEEDBACK_POSTHOG_SURVEY_ID: "survey-1",
    PRODUCT_FEEDBACK_POSTHOG_QUESTION_ID: "question-1",
    PRODUCT_FEEDBACK_CONTACT_RETENTION_DAYS: 90,
  };
}

function signPosthog(rawBody: string, id = "message-1") {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = createHmac("sha256", WEBHOOK_KEY)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return { id, timestamp, signature: `v1,${signature}` };
}

describe("product feedback gateway", () => {
  it("issues and atomically redeems a local validation grant", async () => {
    const store = new MemoryFeedbackStore();
    const app = createFeedbackGateway({ config: config(), store, now: () => NOW });
    const submissionId = "a1b2c3d4-1111-4222-8333-123456789abc";
    const grantBody = JSON.stringify({
      submissionId,
      followUpConsent: true,
      reporterEmail: "person@example.com",
    });
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const nonce = "nonce-1";
    const signature = issuerSignature({ secret: ISSUER_SECRET, timestamp, nonce, body: grantBody });
    const grantResponse = await request(app)
      .post("/v1/grants")
      .set("Content-Type", "application/json")
      .set("x-paperclip-issuer", "paperclip-local-canary")
      .set("x-paperclip-timestamp", timestamp)
      .set("x-paperclip-nonce", nonce)
      .set("x-paperclip-signature", `v1=${signature}`)
      .send(grantBody);
    expect(grantResponse.status).toBe(201);
    expect(grantResponse.body).toMatchObject({
      submissionMode: "local_validation",
      validationRunId: "validation-run-1",
      opaqueInstallationId: "installation-test",
    });

    const delivery = JSON.stringify({
      event: "survey sent",
      distinct_id: submissionId,
      survey_id: "survey-1",
      question_id: "question-1",
      schema_version: "paperclip-product-feedback-v1",
      feedback: "The issue list flickers when I filter it.",
      submission_id: submissionId,
      grant_token: grantResponse.body.grantToken,
      submission_mode: "local_validation",
      validation_run_id: "validation-run-1",
      installation_ref: "installation-test",
      client_timestamp: NOW.toISOString(),
      route_template: "/LOOA/issues/:issueId",
      app_version: "0.3.1",
      deployment_mode: "local_trusted",
      browser: "Chrome 140",
      operating_system: "macOS",
      diagnostics: [],
    });
    const webhook = signPosthog(delivery);
    const accepted = await request(app)
      .post("/v1/posthog/events")
      .set("Content-Type", "application/json")
      .set("webhook-id", webhook.id)
      .set("webhook-timestamp", webhook.timestamp)
      .set("webhook-signature", webhook.signature)
      .send(delivery);
    expect(accepted.status).toBe(202);
    expect(store.receipts.get(submissionId)).toMatchObject({
      receivedAt: NOW,
    });

    const duplicate = await request(app)
      .post("/v1/posthog/events")
      .set("Content-Type", "application/json")
      .set("webhook-id", webhook.id)
      .set("webhook-timestamp", webhook.timestamp)
      .set("webhook-signature", webhook.signature)
      .send(delivery);
    expect(duplicate.status).toBe(200);
    expect(store.receipts.size).toBe(1);
  });

  it("rejects replayed issuer requests", async () => {
    const store = new MemoryFeedbackStore();
    const app = createFeedbackGateway({ config: config(), store, now: () => NOW });
    const body = JSON.stringify({
      submissionId: "b1b2c3d4-1111-4222-8333-123456789abc",
      followUpConsent: false,
    });
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const nonce = "reused-nonce";
    const signature = issuerSignature({ secret: ISSUER_SECRET, timestamp, nonce, body });
    const send = () => request(app)
      .post("/v1/grants")
      .set("Content-Type", "application/json")
      .set("x-paperclip-issuer", "paperclip-local-canary")
      .set("x-paperclip-timestamp", timestamp)
      .set("x-paperclip-nonce", nonce)
      .set("x-paperclip-signature", `v1=${signature}`)
      .send(body);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(409);
  });

  it("rejects identity and deployment fields outside the signed grant contract", async () => {
    const store = new MemoryFeedbackStore();
    const app = createFeedbackGateway({ config: config(), store, now: () => NOW });
    const body = JSON.stringify({
      submissionId: "d1b2c3d4-1111-4222-8333-123456789abc",
      followUpConsent: false,
      authenticatedUserId: "board-user-1",
      deploymentMode: "authenticated",
    });
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const nonce = "strict-contract-nonce";
    const signature = issuerSignature({ secret: ISSUER_SECRET, timestamp, nonce, body });
    const response = await request(app)
      .post("/v1/grants")
      .set("Content-Type", "application/json")
      .set("x-paperclip-issuer", "paperclip-local-canary")
      .set("x-paperclip-timestamp", timestamp)
      .set("x-paperclip-nonce", nonce)
      .set("x-paperclip-signature", `v1=${signature}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("invalid_grant_request");
  });

  it("purges expired contact grants after the configured retention period", async () => {
    const store = new MemoryFeedbackStore();
    const cfg = config();
    const app = createFeedbackGateway({ config: cfg, store, now: () => NOW });
    const submissionId = "c1b2c3d4-1111-4222-8333-123456789abc";
    const body = JSON.stringify({ submissionId, followUpConsent: false });
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const signature = issuerSignature({ secret: ISSUER_SECRET, timestamp, nonce: "retention-nonce", body });
    expect((await request(app)
      .post("/v1/grants")
      .set("Content-Type", "application/json")
      .set("x-paperclip-issuer", "paperclip-local-canary")
      .set("x-paperclip-timestamp", timestamp)
      .set("x-paperclip-nonce", "retention-nonce")
      .set("x-paperclip-signature", `v1=${signature}`)
      .send(body)).status).toBe(201);

    await store.purgeExpired(new Date("2026-12-02T03:00:01.000Z"), cfg.PRODUCT_FEEDBACK_CONTACT_RETENTION_DAYS);
    expect(store.grants.has(submissionId)).toBe(false);
  });
});
