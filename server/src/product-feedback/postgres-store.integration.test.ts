import { randomUUID } from "node:crypto";
import { createPostgresClient } from "@paperclipai/db/postgres-client";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresFeedbackStore } from "./postgres-store.js";
import { issueGrantToken } from "./security.js";

const databaseUrl = process.env.PRODUCT_FEEDBACK_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Postgres feedback store", () => {
  const store = PostgresFeedbackStore.connect(databaseUrl!);
  const cleanup = createPostgresClient(databaseUrl!, { max: 1, prepare: false });
  const submissionIds: string[] = [];

  afterAll(async () => {
    if (submissionIds.length > 0) {
      await cleanup`DELETE FROM feedback_submissions WHERE submission_id = ANY(${submissionIds})`;
      await cleanup`DELETE FROM feedback_grants WHERE submission_id = ANY(${submissionIds})`;
    }
    await Promise.all([store.close(), cleanup.end({ timeout: 5 })]);
  });

  it("persists a grant and atomically records its verified receipt exactly once", async () => {
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
    const eventHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await expect(store.redeemGrantAndRecord({ claims: issued.claims, eventHash, now })).resolves.toBe("accepted");
    await expect(store.redeemGrantAndRecord({ claims: issued.claims, eventHash, now })).resolves.toBe("duplicate");
    const [receipt] = await cleanup`
      SELECT event_hash, received_at
      FROM feedback_submissions
      WHERE submission_id = ${submissionId}
    `;
    expect(receipt).toMatchObject({ event_hash: eventHash });
  });
});
