import { PassThrough } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { ProductFeedbackCapability } from "@paperclipai/shared";
import { createHttpLogger } from "../middleware/logger.js";
import { productFeedbackRoutes, type ProductFeedbackGrantBroker } from "../routes/product-feedback.js";

const enabledCapability: ProductFeedbackCapability = {
  enabled: true,
  provider: "posthog",
  posthog: {
    apiHost: "https://us.i.posthog.com",
    projectToken: "phc_public_test_token",
    surveyId: "survey-id",
    questionId: "question-id",
  },
  limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
};

function createApp(input: {
  capability?: ProductFeedbackCapability;
  actor?: Partial<Express.Request["actor"]>;
  broker?: ProductFeedbackGrantBroker;
  logStream?: PassThrough;
} = {}) {
  const app = express();
  if (input.logStream) {
    app.use(createHttpLogger(pino({ level: "error" }, input.logStream)));
  }
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...input.actor,
    };
    next();
  });
  app.use("/api", productFeedbackRoutes({
    capability: input.capability ?? enabledCapability,
    broker: input.broker,
  }));
  return app;
}

const validRequest = {
  submissionId: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
  followUpConsent: true,
  reporterEmail: "reporter@example.com",
};

describe("POST /api/product-feedback/grant", () => {
  it("is absent while the capability is disabled", async () => {
    const response = await request(createApp({
      capability: { ...enabledCapability, enabled: false, posthog: undefined },
    })).post("/api/product-feedback/grant").send(validRequest);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "product_feedback_disabled",
      error: "Product feedback is not enabled.",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("fails closed without a server-bound broker and preserves a safe retry message", async () => {
    const response = await request(createApp())
      .post("/api/product-feedback/grant")
      .send(validRequest);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "product_feedback_grant_unavailable",
      error: "Feedback delivery is not available on this instance yet. Your draft is still here.",
    });
    expect(JSON.stringify(response.body)).not.toContain("reporter@example.com");
  });

  it("redacts reporter email from HTTP error logs on the fail-closed path", async () => {
    const logStream = new PassThrough();
    let output = "";
    logStream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const response = await request(createApp({ logStream }))
      .post("/api/product-feedback/grant")
      .send({ ...validRequest, reporterEmail: "privacy-canary@example.test" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.status).toBe(503);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("privacy-canary@example.test");
  });

  it("rejects browser-selectable trust and malformed contact input", async () => {
    const response = await request(createApp())
      .post("/api/product-feedback/grant")
      .send({
        ...validRequest,
        followUpConsent: false,
        trusted: true,
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("invalid_product_feedback_grant_request");
  });

  it("requires contact data exactly when follow-up consent is enabled", async () => {
    const missingEmail = await request(createApp())
      .post("/api/product-feedback/grant")
      .send({
        submissionId: validRequest.submissionId,
        followUpConsent: true,
      });
    const unexpectedEmail = await request(createApp())
      .post("/api/product-feedback/grant")
      .send({
        ...validRequest,
        followUpConsent: false,
      });

    expect(missingEmail.status).toBe(400);
    expect(missingEmail.body.code).toBe("invalid_product_feedback_grant_request");
    expect(unexpectedEmail.status).toBe(400);
    expect(unexpectedEmail.body.code).toBe("invalid_product_feedback_grant_request");
  });

  it("requires a board session", async () => {
    const response = await request(createApp({ actor: { type: "agent", source: "api_key" } }))
      .post("/api/product-feedback/grant")
      .send(validRequest);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("board_session_required");
  });

  it("hands contact data only to the authenticated server broker", async () => {
    const issueGrant = vi.fn().mockResolvedValue({
      grantToken: "single-use-grant",
      submissionMode: "production_feedback",
      opaqueInstallationId: "installation-ref",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });

    const response = await request(createApp({
      actor: { source: "session" },
      broker: { issueGrant },
    })).post("/api/product-feedback/grant").send(validRequest);

    expect(response.status).toBe(201);
    expect(issueGrant).toHaveBeenCalledWith({
      ...validRequest,
    });
    expect(response.body).toEqual({
      grantToken: "single-use-grant",
      submissionMode: "production_feedback",
      opaqueInstallationId: "installation-ref",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
  });
});
