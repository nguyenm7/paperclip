import type { FeedbackStore, GrantRecord, QueueJob } from "./store.js";
import type { GrantClaims, PosthogFeedbackDelivery } from "./contracts.js";

export class MemoryFeedbackStore implements FeedbackStore {
  readonly grants = new Map<string, GrantRecord>();
  readonly submissions = new Map<string, PosthogFeedbackDelivery>();
  readonly jobs: QueueJob[] = [];
  readonly webhookSecrets = new Map<string, { secretCiphertext: string; resourceGid: string }>();
  readonly deliveryHashes = new Set<string>();
  readonly asanaLinks = new Map<string, { taskGid: string; status: string }>();
  private nonces = new Map<string, Date>();
  private nextJobId = 1;

  async claimIssuerNonce(issuerId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const key = `${issuerId}:${nonce}`;
    const existing = this.nonces.get(key);
    if (existing && existing > new Date()) return false;
    this.nonces.set(key, expiresAt);
    return true;
  }

  async createGrant(record: GrantRecord): Promise<void> {
    if (this.grants.has(record.claims.submissionId)) throw new Error("duplicate_submission");
    this.grants.set(record.claims.submissionId, record);
  }

  async redeemGrantAndEnqueue(input: {
    claims: GrantClaims;
    delivery: PosthogFeedbackDelivery;
    now: Date;
  }): Promise<"accepted" | "duplicate" | "invalid"> {
    if (this.submissions.has(input.claims.submissionId)) return "duplicate";
    const grant = this.grants.get(input.claims.submissionId);
    if (!grant || grant.claims.jti !== input.claims.jti || input.claims.exp * 1000 <= input.now.getTime()) return "invalid";
    this.submissions.set(input.claims.submissionId, input.delivery);
    this.jobs.push({
      id: String(this.nextJobId++),
      kind: "asana_create",
      payload: { submissionId: input.claims.submissionId },
      attempts: 0,
    });
    return "accepted";
  }

  async getGrant(submissionId: string): Promise<GrantRecord | null> {
    return this.grants.get(submissionId) ?? null;
  }

  async getSubmission(submissionId: string): Promise<PosthogFeedbackDelivery | null> {
    return this.submissions.get(submissionId) ?? null;
  }

  async registerAsanaWebhook(input: { webhookGid: string; resourceGid: string; secretCiphertext: string }): Promise<void> {
    this.webhookSecrets.set(input.webhookGid, {
      secretCiphertext: input.secretCiphertext,
      resourceGid: input.resourceGid,
    });
  }

  async findActiveAsanaWebhook(webhookGid: string): Promise<{ secretCiphertext: string } | null> {
    const value = this.webhookSecrets.get(webhookGid);
    return value ? { secretCiphertext: value.secretCiphertext } : null;
  }

  async recordAsanaDeliveryAndEnqueue(input: {
    webhookGid: string;
    deliveryHash: string;
    events: unknown[];
  }): Promise<boolean> {
    if (this.deliveryHashes.has(input.deliveryHash)) return false;
    this.deliveryHashes.add(input.deliveryHash);
    this.jobs.push({
      id: String(this.nextJobId++),
      kind: "asana_reconcile",
      payload: { webhookGid: input.webhookGid, events: input.events },
      attempts: 0,
    });
    return true;
  }

  async claimQueueJob(_workerId: string, _now: Date): Promise<QueueJob | null> {
    return this.jobs.shift() ?? null;
  }

  async completeQueueJob(_id: string): Promise<void> {}
  async retryQueueJob(_id: string, _errorCode: string, _availableAt: Date, _dead: boolean): Promise<void> {}

  async getAsanaTaskLink(submissionId: string): Promise<{ taskGid: string; status: string } | null> {
    const value = this.asanaLinks.get(submissionId);
    return value ? { taskGid: value.taskGid, status: value.status } : null;
  }

  async saveAsanaTaskLink(input: { submissionId: string; taskGid: string; status: string }): Promise<void> {
    this.asanaLinks.set(input.submissionId, { taskGid: input.taskGid, status: input.status });
  }

  async close(): Promise<void> {}
}
