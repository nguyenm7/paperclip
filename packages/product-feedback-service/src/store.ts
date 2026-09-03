import type { GrantClaims, PosthogFeedbackDelivery } from "./contracts.js";

export interface GrantRecord {
  claims: GrantClaims;
  followUpConsent: boolean;
  reporterEmailCiphertext: string | null;
}

export interface QueueJob {
  id: string;
  kind: "asana_create" | "asana_reconcile";
  payload: Record<string, unknown>;
  attempts: number;
}

export interface FeedbackStore {
  claimIssuerNonce(issuerId: string, nonce: string, expiresAt: Date): Promise<boolean>;
  createGrant(record: GrantRecord): Promise<void>;
  redeemGrantAndEnqueue(input: {
    claims: GrantClaims;
    delivery: PosthogFeedbackDelivery;
    now: Date;
  }): Promise<"accepted" | "duplicate" | "invalid">;
  getGrant(submissionId: string): Promise<GrantRecord | null>;
  getSubmission(submissionId: string): Promise<PosthogFeedbackDelivery | null>;
  registerAsanaWebhook(input: {
    webhookGid: string;
    resourceGid: string;
    secretCiphertext: string;
  }): Promise<boolean>;
  findActiveAsanaWebhook(webhookGid: string): Promise<{ secretCiphertext: string } | null>;
  recordAsanaDeliveryAndEnqueue(input: {
    webhookGid: string;
    deliveryHash: string;
    events: unknown[];
  }): Promise<boolean>;
  claimQueueJob(workerId: string, now: Date): Promise<QueueJob | null>;
  completeQueueJob(id: string): Promise<void>;
  retryQueueJob(id: string, errorCode: string, availableAt: Date, dead: boolean): Promise<void>;
  getAsanaTaskLink(submissionId: string): Promise<{ taskGid: string; status: string } | null>;
  saveAsanaTaskLink(input: { submissionId: string; taskGid: string; status: string }): Promise<void>;
  close(): Promise<void>;
}
