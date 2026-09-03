import express, { type Request } from "express";
import { productFeedbackGrantSchema } from "@paperclipai/shared";
import { asanaWebhookEnvelopeSchema, brokerGrantRequestSchema, posthogFeedbackDeliverySchema } from "./contracts.js";
import type { GatewayConfig } from "./config.js";
import type { FeedbackStore } from "./store.js";
import {
  decryptContact,
  encryptContact,
  issueGrantToken,
  sha256,
  verifyAsanaWebhook,
  verifyGrantToken,
  verifyIssuerSignature,
  verifyStandardWebhook,
} from "./security.js";

const BODY_LIMIT = "64kb";
const GRANT_TTL_SECONDS = 10 * 60;

function rawBody(request: Request): Buffer {
  if (!Buffer.isBuffer(request.body)) throw new Error("raw_body_required");
  return request.body;
}

function header(request: Request, name: string): string | null {
  const value = request.header(name);
  return value?.trim() || null;
}

function parseRawJson(body: Buffer): unknown {
  return JSON.parse(body.toString("utf8"));
}

function grantMatchesDelivery(
  claims: ReturnType<typeof verifyGrantToken>,
  delivery: ReturnType<typeof posthogFeedbackDeliverySchema.parse>,
): boolean {
  return claims.submissionId === delivery.submission_id
    && delivery.distinct_id === delivery.submission_id
    && claims.installationRef === delivery.installation_ref
    && claims.submissionMode === delivery.submission_mode
    && (claims.validationRunId ?? null) === delivery.validation_run_id;
}

export function createFeedbackGateway(input: {
  config: GatewayConfig;
  store: FeedbackStore;
  now?: () => Date;
}): express.Express {
  const app = express();
  const now = input.now ?? (() => new Date());
  app.disable("x-powered-by");

  app.get("/healthz", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ ok: true, service: "paperclip-product-feedback-gateway" });
  });

  app.post("/v1/grants", express.raw({ type: "application/json", limit: BODY_LIMIT }), async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const body = rawBody(request);
    const issuerId = header(request, "x-paperclip-issuer");
    const timestamp = header(request, "x-paperclip-timestamp");
    const nonce = header(request, "x-paperclip-nonce");
    const signature = header(request, "x-paperclip-signature");
    if (
      issuerId !== input.config.PRODUCT_FEEDBACK_ISSUER_ID
      || !timestamp
      || !nonce
      || nonce.length > 200
      || !signature
      || !verifyIssuerSignature({
        secret: input.config.PRODUCT_FEEDBACK_ISSUER_SECRET,
        timestamp,
        nonce,
        body,
        signature,
        now: now(),
      })
    ) {
      response.status(401).json({ code: "invalid_issuer" });
      return;
    }
    const acceptedNonce = await input.store.claimIssuerNonce(
      issuerId,
      nonce,
      new Date(now().getTime() + 10 * 60 * 1000),
    );
    if (!acceptedNonce) {
      response.status(409).json({ code: "issuer_replay" });
      return;
    }

    const parsed = brokerGrantRequestSchema.safeParse(parseRawJson(body));
    if (!parsed.success) {
      response.status(400).json({ code: "invalid_grant_request" });
      return;
    }

    const validationRunId = input.config.PRODUCT_FEEDBACK_VALIDATION_RUN_ID;
    if (input.config.PRODUCT_FEEDBACK_SUBMISSION_MODE === "local_validation") {
      const expiresAt = Date.parse(input.config.PRODUCT_FEEDBACK_VALIDATION_EXPIRES_AT ?? "");
      if (!validationRunId || !Number.isFinite(expiresAt) || expiresAt <= now().getTime()) {
        response.status(503).json({ code: "validation_window_closed" });
        return;
      }
    }

    const issued = issueGrantToken({
      signingSecret: input.config.PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET,
      submissionId: parsed.data.submissionId,
      installationRef: input.config.PRODUCT_FEEDBACK_INSTALLATION_REF,
      submissionMode: input.config.PRODUCT_FEEDBACK_SUBMISSION_MODE,
      ...(validationRunId ? { validationRunId } : {}),
      ttlSeconds: GRANT_TTL_SECONDS,
      now: now(),
    });
    try {
      await input.store.createGrant({
        claims: issued.claims,
        followUpConsent: parsed.data.followUpConsent,
        reporterEmailCiphertext: parsed.data.reporterEmail
          ? encryptContact(parsed.data.reporterEmail, input.config.PRODUCT_FEEDBACK_CONTACT_ENCRYPTION_KEY)
          : null,
      });
    } catch {
      response.status(409).json({ code: "duplicate_submission" });
      return;
    }
    response.status(201).json(productFeedbackGrantSchema.parse({
      grantToken: issued.token,
      submissionMode: issued.claims.submissionMode,
      ...(issued.claims.validationRunId ? { validationRunId: issued.claims.validationRunId } : {}),
      opaqueInstallationId: issued.claims.installationRef,
      expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
    }));
  });

  app.post("/v1/posthog/events", express.raw({ type: "application/json", limit: BODY_LIMIT }), async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const body = rawBody(request);
    const webhookId = header(request, "webhook-id");
    const webhookTimestamp = header(request, "webhook-timestamp");
    const webhookSignature = header(request, "webhook-signature");
    if (!webhookId || !webhookTimestamp || !webhookSignature || !verifyStandardWebhook({
      secret: input.config.PRODUCT_FEEDBACK_POSTHOG_WEBHOOK_SECRET,
      rawBody: body,
      webhookId,
      webhookTimestamp,
      webhookSignature,
      now: now(),
    })) {
      response.status(401).json({ code: "invalid_posthog_signature" });
      return;
    }

    const parsed = posthogFeedbackDeliverySchema.safeParse(parseRawJson(body));
    if (!parsed.success
      || parsed.data.survey_id !== input.config.PRODUCT_FEEDBACK_POSTHOG_SURVEY_ID
      || parsed.data.question_id !== input.config.PRODUCT_FEEDBACK_POSTHOG_QUESTION_ID) {
      response.status(400).json({ code: "invalid_feedback_event" });
      return;
    }

    let claims: ReturnType<typeof verifyGrantToken>;
    try {
      claims = verifyGrantToken({
        signingSecret: input.config.PRODUCT_FEEDBACK_GRANT_SIGNING_SECRET,
        token: parsed.data.grant_token,
        now: now(),
      });
    } catch {
      response.status(401).json({ code: "invalid_feedback_grant" });
      return;
    }
    if (!grantMatchesDelivery(claims, parsed.data)) {
      response.status(401).json({ code: "feedback_grant_mismatch" });
      return;
    }
    const result = await input.store.redeemGrantAndEnqueue({ claims, delivery: parsed.data, now: now() });
    if (result === "invalid") {
      response.status(401).json({ code: "feedback_grant_redeemed_or_missing" });
      return;
    }
    response.status(result === "duplicate" ? 200 : 202).json({ accepted: true, duplicate: result === "duplicate" });
  });

  app.post(
    "/v1/asana/webhooks/:webhookRef",
    express.raw({ type: "application/json", limit: BODY_LIMIT }),
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.params.webhookRef !== input.config.PRODUCT_FEEDBACK_ASANA_WEBHOOK_REF) {
        response.status(404).end();
        return;
      }
      const handshakeSecret = header(request, "x-hook-secret");
      if (handshakeSecret) {
        if (handshakeSecret.length < 20 || handshakeSecret.length > 500) {
          response.status(400).end();
          return;
        }
        const registered = await input.store.registerAsanaWebhook({
          webhookGid: request.params.webhookRef,
          resourceGid: input.config.PRODUCT_FEEDBACK_ASANA_PROJECT_GID,
          secretCiphertext: encryptContact(handshakeSecret, input.config.PRODUCT_FEEDBACK_CONTACT_ENCRYPTION_KEY),
        });
        if (!registered) {
          response.status(409).end();
          return;
        }
        response.setHeader("X-Hook-Secret", handshakeSecret);
        response.status(200).end();
        return;
      }

      const registered = await input.store.findActiveAsanaWebhook(request.params.webhookRef);
      const signature = header(request, "x-hook-signature");
      const body = rawBody(request);
      if (!registered || !signature || !verifyAsanaWebhook({
        secret: decryptContact(registered.secretCiphertext, input.config.PRODUCT_FEEDBACK_CONTACT_ENCRYPTION_KEY),
        rawBody: body,
        signature,
      })) {
        response.status(401).end();
        return;
      }
      const parsed = asanaWebhookEnvelopeSchema.safeParse(parseRawJson(body));
      if (!parsed.success) {
        response.status(400).end();
        return;
      }
      await input.store.recordAsanaDeliveryAndEnqueue({
        webhookGid: request.params.webhookRef,
        deliveryHash: sha256(body),
        events: parsed.data.events,
      });
      response.status(200).end();
    },
  );

  app.use((_request, response) => response.status(404).json({ code: "not_found" }));
  app.use((error: unknown, _request: Request, response: express.Response, _next: express.NextFunction) => {
    const code = error instanceof SyntaxError ? "invalid_json" : "internal_error";
    response.status(code === "invalid_json" ? 400 : 500).json({ code });
  });
  return app;
}
