import { describe, expect, it } from "vitest";
import { decryptContact, encryptContact, issueGrantToken, verifyGrantToken } from "./security.js";

describe("feedback security", () => {
  it("encrypts contact details at rest", () => {
    const key = Buffer.alloc(32, 9);
    const submissionId = "a1b2c3d4-1111-4222-8333-123456789abc";
    const encrypted = encryptContact("person@example.com", key, submissionId);
    expect(encrypted).not.toContain("person@example.com");
    expect(decryptContact(encrypted, key, submissionId)).toBe("person@example.com");
    expect(() => decryptContact(encrypted, key, "b1b2c3d4-1111-4222-8333-123456789abc"))
      .toThrow();
  });

  it("rejects expired signed grants", () => {
    const now = new Date("2026-09-02T02:00:00.000Z");
    const issued = issueGrantToken({
      signingSecret: "a-secret-that-is-long-enough-for-tests",
      submissionId: "a1b2c3d4-1111-4222-8333-123456789abc",
      installationRef: "install-1",
      submissionMode: "production_feedback",
      ttlSeconds: 60,
      now,
    });
    expect(verifyGrantToken({ signingSecret: "a-secret-that-is-long-enough-for-tests", token: issued.token, now })).toMatchObject({
      submissionId: "a1b2c3d4-1111-4222-8333-123456789abc",
    });
    expect(() => verifyGrantToken({
      signingSecret: "a-secret-that-is-long-enough-for-tests",
      token: issued.token,
      now: new Date(now.getTime() + 61_000),
    })).toThrow("expired_grant");
  });
});
