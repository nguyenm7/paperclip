import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresFeedbackStore } from "./postgres-store.js";
import { issueGrantToken } from "./security.js";

const databaseUrl = process.env.PRODUCT_FEEDBACK_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Postgres feedback store", () => {
  const store = PostgresFeedbackStore.connect(databaseUrl!);
  const cleanup = postgres(databaseUrl!, { max: 1, prepare: false });
  const submissionIds: string[] = [];

  afterAll(async () => {
    if (submissionIds.length > 0) {
      await cleanup`DELETE FROM feedback_queue_jobs WHERE dedupe_key = ANY(${submissionIds.map((id) => `asana_create:${id}`)})`;
      await cleanup`DELETE FROM feedback_asana_links WHERE submission_id = ANY(${submissionIds})`;
      await cleanup`DELETE FROM feedback_submissions WHERE submission_id = ANY(${submissionIds})`;
      await cleanup`DELETE FROM feedback_grants WHERE submission_id = ANY(${submissionIds})`;
    }
    await Promise.all([store.close(), cleanup.end({ timeout: 5 })]);
  });

  it("persists a grant, atomically redeems it, and enqueues exactly once", async () => {
    const submissionId = randomUUID();
    submissionIds.push(submissionId);
    const now = new Date();
    const issued = issueGrantToken({
      signingSecret: "integration-secret-that-is-long-enough",
      submissionId,
      installationRef: "local-canary",
      submissionMode: "local_validation",
      validationRunId: "local-durable-proof",
      ttlSeconds: 600,
      now,
    });
    await store.createGrant({ claims: issued.claims, followUpConsent: false, reporterEmailCiphertext: null });
    const delivery = {
      event: "survey sent" as const,
      distinct_id: submissionId,
      survey_id: "survey",
      question_id: "question",
      schema_version: "paperclip-product-feedback-v1" as const,
      feedback: "Durable canary feedback",
      submission_id: submissionId,
      grant_token: issued.token,
      submission_mode: "local_validation" as const,
      validation_run_id: "local-durable-proof",
      installation_ref: "local-canary",
      client_timestamp: now.toISOString(),
      route_template: "/LOOA/issues/:issueId",
      app_version: "0.3.1",
      deployment_mode: "local_trusted" as const,
      browser: "test",
      operating_system: "test",
      diagnostics: [],
    };
    await expect(store.redeemGrantAndEnqueue({ claims: issued.claims, delivery, now })).resolves.toBe("accepted");
    await expect(store.redeemGrantAndEnqueue({ claims: issued.claims, delivery, now })).resolves.toBe("duplicate");
    await expect(store.claimQueueJob("integration-worker", now)).resolves.toMatchObject({
      kind: "asana_create",
      payload: { submissionId },
    });
  });
});
