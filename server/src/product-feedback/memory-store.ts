import type { FeedbackStore, GrantRecord } from "./store.js";
import type { GrantClaims } from "./contracts.js";

export class MemoryFeedbackStore implements FeedbackStore {
  readonly grants = new Map<string, GrantRecord>();
  readonly receipts = new Map<string, { eventHash: string; receivedAt: Date }>();
  private nonces = new Map<string, Date>();

  async claimIssuerNonce(issuerId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const key = `${issuerId}:${nonce}`;
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, expiresAt);
    return true;
  }

  async createGrant(record: GrantRecord): Promise<void> {
    if (this.grants.has(record.claims.submissionId)) throw new Error("duplicate_submission");
    this.grants.set(record.claims.submissionId, record);
  }

  async redeemGrantAndRecord(input: {
    claims: GrantClaims;
    eventHash: string;
    now: Date;
  }): Promise<"accepted" | "duplicate" | "invalid"> {
    if (this.receipts.has(input.claims.submissionId)) return "duplicate";
    const grant = this.grants.get(input.claims.submissionId);
    if (!grant || grant.claims.jti !== input.claims.jti || input.claims.exp * 1000 <= input.now.getTime()) return "invalid";
    this.receipts.set(input.claims.submissionId, { eventHash: input.eventHash, receivedAt: input.now });
    return "accepted";
  }

  async purgeExpired(now: Date, contactRetentionDays: number): Promise<void> {
    const retainedAfter = now.getTime() - contactRetentionDays * 24 * 60 * 60 * 1000;
    for (const [submissionId, grant] of this.grants) {
      const receipt = this.receipts.get(submissionId);
      const shouldDelete = receipt
        ? receipt.receivedAt.getTime() < retainedAfter
        : grant.claims.exp * 1000 < now.getTime();
      if (shouldDelete) {
        this.grants.delete(submissionId);
        this.receipts.delete(submissionId);
      }
    }
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt.getTime() < now.getTime()) this.nonces.delete(key);
    }
  }

  async close(): Promise<void> {}
}
