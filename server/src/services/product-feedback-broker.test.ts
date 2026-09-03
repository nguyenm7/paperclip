import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHttpProductFeedbackGrantBroker } from "./product-feedback-broker.js";

describe("HTTP product feedback grant broker", () => {
  it("signs the exact request body and validates the response contract", async () => {
    const secret = "issuer-secret-that-is-long-enough-for-tests";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const timestamp = headers.get("x-paperclip-timestamp")!;
      const nonce = headers.get("x-paperclip-nonce")!;
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}\n${nonce}\n${body}`)
        .digest("base64url");
      expect(headers.get("x-paperclip-signature")).toBe(`v1=${expected}`);
      expect(body).not.toContain(secret);
      expect(JSON.parse(body)).toEqual({
        submissionId: "a1b2c3d4-1111-4222-8333-123456789abc",
        followUpConsent: false,
      });
      return new Response(JSON.stringify({
        grantToken: "signed-one-use-grant",
        submissionMode: "local_validation",
        validationRunId: "run-1",
        opaqueInstallationId: "install-1",
        expiresAt: "2026-09-02T03:00:00.000Z",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    const broker = createHttpProductFeedbackGrantBroker({
      endpoint: "https://feedback.paperclip.ing/v1/grants",
      issuerId: "paperclip-local-canary",
      issuerSecret: secret,
    }, fetchImpl as typeof fetch);
    await expect(broker.issueGrant({
      submissionId: "a1b2c3d4-1111-4222-8333-123456789abc",
      followUpConsent: false,
    })).resolves.toMatchObject({ submissionMode: "local_validation", validationRunId: "run-1" });
  });

  it("rejects oversized broker responses", async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12 * 1024));
        controller.enqueue(new Uint8Array(12 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const broker = createHttpProductFeedbackGrantBroker({
      endpoint: "https://feedback.paperclip.ing/v1/grants",
      issuerId: "paperclip-local-canary",
      issuerSecret: "issuer-secret-that-is-long-enough-for-tests",
    }, vi.fn(async () => new Response(oversizedBody, { status: 200 })) as typeof fetch);
    await expect(broker.issueGrant({
      submissionId: "a1b2c3d4-1111-4222-8333-123456789abc",
      followUpConsent: false,
    })).rejects.toThrow("feedback_broker_response_too_large");
    expect(cancelled).toBe(true);
  });
});
