import postgres, { type Sql } from "postgres";
import type { GrantClaims, PosthogFeedbackDelivery } from "./contracts.js";
import type { FeedbackStore, GrantRecord, QueueJob } from "./store.js";

type Row = Record<string, unknown>;

export class PostgresFeedbackStore implements FeedbackStore {
  constructor(private readonly sql: Sql<Row>) {}

  static connect(databaseUrl: string): PostgresFeedbackStore {
    return new PostgresFeedbackStore(postgres(databaseUrl, {
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

  async redeemGrantAndEnqueue(input: {
    claims: GrantClaims;
    delivery: PosthogFeedbackDelivery;
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
      if (grants.length !== 1) return "invalid" as const;

      const delivery = input.delivery;
      await tx`
        INSERT INTO feedback_submissions (
          submission_id, grant_jti, installation_ref, submission_mode, validation_run_id,
          feedback_body, route_template, app_version, deployment_mode, browser,
          operating_system, diagnostics, client_timestamp, received_at
        ) VALUES (
          ${input.claims.submissionId}, ${input.claims.jti}, ${input.claims.installationRef},
          ${input.claims.submissionMode}, ${input.claims.validationRunId ?? null},
          ${delivery.feedback}, ${delivery.route_template}, ${delivery.app_version},
          ${delivery.deployment_mode}, ${delivery.browser}, ${delivery.operating_system},
          ${tx.json(delivery.diagnostics)}, ${new Date(delivery.client_timestamp)}, ${input.now}
        )
      `;
      await tx`
        INSERT INTO feedback_queue_jobs (kind, dedupe_key, payload, available_at, created_at, updated_at)
        VALUES (
          'asana_create',
          ${`asana_create:${input.claims.submissionId}`},
          ${tx.json({ submissionId: input.claims.submissionId })},
          ${input.now},
          ${input.now},
          ${input.now}
        )
        ON CONFLICT (dedupe_key) DO NOTHING
      `;
      return "accepted" as const;
    });
  }

  async getGrant(submissionId: string): Promise<GrantRecord | null> {
    const rows = await this.sql`
      SELECT jti, submission_id, installation_ref, submission_mode, validation_run_id,
        follow_up_consent, reporter_email_ciphertext, issued_at, expires_at
      FROM feedback_grants
      WHERE submission_id = ${submissionId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      claims: {
        v: 1,
        jti: String(row.jti),
        submissionId: String(row.submission_id),
        installationRef: String(row.installation_ref),
        submissionMode: row.submission_mode as GrantClaims["submissionMode"],
        ...(row.validation_run_id ? { validationRunId: String(row.validation_run_id) } : {}),
        iat: Math.floor(new Date(row.issued_at as string | Date).getTime() / 1000),
        exp: Math.floor(new Date(row.expires_at as string | Date).getTime() / 1000),
      },
      followUpConsent: Boolean(row.follow_up_consent),
      reporterEmailCiphertext: row.reporter_email_ciphertext ? String(row.reporter_email_ciphertext) : null,
    };
  }

  async getSubmission(submissionId: string): Promise<PosthogFeedbackDelivery | null> {
    const rows = await this.sql`
      SELECT s.*, g.submission_id
      FROM feedback_submissions s
      JOIN feedback_grants g ON g.jti = s.grant_jti
      WHERE s.submission_id = ${submissionId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      event: "survey sent",
      distinct_id: String(row.submission_id),
      survey_id: "stored",
      question_id: "stored",
      schema_version: "paperclip-product-feedback-v1",
      feedback: String(row.feedback_body),
      submission_id: String(row.submission_id),
      grant_token: "stored-redacted",
      submission_mode: row.submission_mode as PosthogFeedbackDelivery["submission_mode"],
      validation_run_id: row.validation_run_id ? String(row.validation_run_id) : null,
      installation_ref: String(row.installation_ref),
      client_timestamp: new Date(row.client_timestamp as string | Date).toISOString(),
      route_template: String(row.route_template),
      app_version: row.app_version ? String(row.app_version) : null,
      deployment_mode: row.deployment_mode as PosthogFeedbackDelivery["deployment_mode"],
      browser: String(row.browser),
      operating_system: String(row.operating_system),
      diagnostics: row.diagnostics as PosthogFeedbackDelivery["diagnostics"],
    };
  }

  async registerAsanaWebhook(input: {
    webhookGid: string;
    resourceGid: string;
    secretCiphertext: string;
  }): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO feedback_asana_webhooks (webhook_gid, resource_gid, secret_ciphertext)
      VALUES (${input.webhookGid}, ${input.resourceGid}, ${input.secretCiphertext})
      ON CONFLICT (webhook_gid) DO NOTHING
      RETURNING webhook_gid
    `;
    return rows.length === 1;
  }

  async findActiveAsanaWebhook(webhookGid: string): Promise<{ secretCiphertext: string } | null> {
    const rows = await this.sql`
      SELECT secret_ciphertext FROM feedback_asana_webhooks
      WHERE webhook_gid = ${webhookGid} AND active = true
    `;
    const row = rows[0];
    return row ? { secretCiphertext: String(row.secret_ciphertext) } : null;
  }

  async recordAsanaDeliveryAndEnqueue(input: {
    webhookGid: string;
    deliveryHash: string;
    events: unknown[];
  }): Promise<boolean> {
    const payload = JSON.parse(JSON.stringify({ webhookGid: input.webhookGid, events: input.events }));
    return this.sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO feedback_asana_deliveries (delivery_hash, webhook_gid, event_count)
        VALUES (${input.deliveryHash}, ${input.webhookGid}, ${input.events.length})
        ON CONFLICT DO NOTHING
        RETURNING delivery_hash
      `;
      if (inserted.length === 0) return false;
      await tx`
        INSERT INTO feedback_queue_jobs (kind, dedupe_key, payload)
        VALUES (
          'asana_reconcile',
          ${`asana_reconcile:${input.deliveryHash}`},
          ${tx.json(payload)}
        )
      `;
      return true;
    });
  }

  async claimQueueJob(workerId: string, now: Date): Promise<QueueJob | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, kind, payload, attempts
        FROM feedback_queue_jobs
        WHERE status = 'pending' AND available_at <= ${now}
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      await tx`
        UPDATE feedback_queue_jobs
        SET status = 'running', locked_at = ${now}, locked_by = ${workerId},
          attempts = attempts + 1, updated_at = ${now}
        WHERE id = ${String(row.id)}
      `;
      return {
        id: String(row.id),
        kind: row.kind as QueueJob["kind"],
        payload: row.payload as Record<string, unknown>,
        attempts: Number(row.attempts) + 1,
      };
    });
  }

  async completeQueueJob(id: string): Promise<void> {
    await this.sql`
      UPDATE feedback_queue_jobs
      SET status = 'complete', locked_at = null, locked_by = null, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async retryQueueJob(id: string, errorCode: string, availableAt: Date, dead: boolean): Promise<void> {
    await this.sql`
      UPDATE feedback_queue_jobs
      SET status = ${dead ? "dead" : "pending"}, available_at = ${availableAt},
        locked_at = null, locked_by = null, last_error_code = ${errorCode}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async getAsanaTaskLink(submissionId: string): Promise<{ taskGid: string; status: string } | null> {
    const rows = await this.sql`
      SELECT task_gid, last_applied_status FROM feedback_asana_links WHERE submission_id = ${submissionId}
    `;
    return rows[0]
      ? { taskGid: String(rows[0].task_gid), status: String(rows[0].last_applied_status) }
      : null;
  }

  async saveAsanaTaskLink(input: { submissionId: string; taskGid: string; status: string }): Promise<void> {
    await this.sql`
      INSERT INTO feedback_asana_links (submission_id, task_gid, last_applied_status)
      VALUES (${input.submissionId}, ${input.taskGid}, ${input.status})
      ON CONFLICT (submission_id) DO UPDATE SET
        task_gid = EXCLUDED.task_gid,
        last_applied_status = EXCLUDED.last_applied_status,
        updated_at = now()
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
