import type { GrantClaims } from "./contracts.js";

export interface GrantRecord {
  claims: GrantClaims;
  followUpConsent: boolean;
  reporterEmailCiphertext: string | null;
}

export interface FeedbackStore {
  claimIssuerNonce(issuerId: string, nonce: string, expiresAt: Date): Promise<boolean>;
  createGrant(record: GrantRecord): Promise<void>;
  redeemGrantAndRecord(input: {
    claims: GrantClaims;
    eventHash: string;
    now: Date;
  }): Promise<"accepted" | "duplicate" | "invalid">;
  purgeExpired(now: Date, contactRetentionDays: number): Promise<void>;
  close(): Promise<void>;
}
