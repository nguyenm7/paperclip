import { createPostgresClient, type PostgresClient } from "@paperclipai/db/postgres-client";
import type { GrantClaims } from "./contracts.js";
import type { FeedbackStore, GrantRecord } from "./store.js";

export class PostgresFeedbackStore implements FeedbackStore {
  constructor(private readonly sql: PostgresClient) {}

  static connect(databaseUrl: string): PostgresFeedbackStore {
    return new PostgresFeedbackStore(createPostgresClient(databaseUrl, {
      max: 8,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => undefined,
    }));
  }

  async claimIssuerNonce(issuerId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO feedback_issuer_nonces (issuer_id, nonce, expires_at)
      VALUES (${issuerId}, ${nonce}, ${expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING nonce
    `;
    return rows.length === 1;
  }

  async createGrant(record: GrantRecord): Promise<void> {
    const { claims } = record;
    await this.sql`
      INSERT INTO feedback_grants (
        jti, submission_id, installation_ref, submission_mode, validation_run_id,
        follow_up_consent, reporter_email_ciphertext, issued_at, expires_at
      ) VALUES (
        ${claims.jti}, ${claims.submissionId}, ${claims.installationRef}, ${claims.submissionMode},
        ${claims.validationRunId ?? null}, ${record.followUpConsent}, ${record.reporterEmailCiphertext},
        ${new Date(claims.iat * 1000)}, ${new Date(claims.exp * 1000)}
      )
    `;
  }

  async redeemGrantAndRecord(input: {
    claims: GrantClaims;
    eventHash: string;
    now: Date;
  }): Promise<"accepted" | "duplicate" | "invalid"> {
    return this.sql.begin(async (tx) => {
      const existing = await tx`
        SELECT submission_id FROM feedback_submissions WHERE submission_id = ${input.claims.submissionId}
      `;
      if (existing.length > 0) return "duplicate" as const;

      const grants = await tx`
        UPDATE feedback_grants
        SET redeemed_at = ${input.now}
        WHERE jti = ${input.claims.jti}
          AND submission_id = ${input.claims.submissionId}
          AND redeemed_at IS NULL
          AND expires_at > ${input.now}
        RETURNING jti
      `;
      if (grants.length !== 1) {
        // A concurrent delivery can wait on the same grant row and then find
        // it already redeemed. Read again in this transaction's new
        // READ COMMITTED snapshot so an accepted delivery stays idempotent.
        const duplicate = await tx`
          SELECT submission_id
          FROM feedback_submissions
          WHERE submission_id = ${input.claims.submissionId}
        `;
        return duplicate.length > 0 ? "duplicate" as const : "invalid" as const;
      }

      await tx`
        INSERT INTO feedback_submissions (
          submission_id, grant_jti, installation_ref, submission_mode, validation_run_id,
          event_hash, received_at
        ) VALUES (
          ${input.claims.submissionId}, ${input.claims.jti}, ${input.claims.installationRef},
          ${input.claims.submissionMode}, ${input.claims.validationRunId ?? null},
          ${input.eventHash}, ${input.now}
        )
      `;
      return "accepted" as const;
    });
  }

  async purgeExpired(now: Date, contactRetentionDays: number): Promise<void> {
    const retainedAfter = new Date(now.getTime() - contactRetentionDays * 24 * 60 * 60 * 1000);
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM feedback_issuer_nonces WHERE expires_at < ${now}`;
      await tx`
        DELETE FROM feedback_grants
        WHERE (redeemed_at IS NULL AND expires_at < ${now})
          OR (redeemed_at IS NOT NULL AND redeemed_at < ${retainedAfter})
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
