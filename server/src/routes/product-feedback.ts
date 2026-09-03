import { Router } from "express";
import {
  productFeedbackGrantRequestSchema,
  productFeedbackGrantSchema,
  type ProductFeedbackBrokerRequest,
  type ProductFeedbackCapability,
  type ProductFeedbackGrant,
} from "@paperclipai/shared";

export interface ProductFeedbackGrantBroker {
  issueGrant(request: ProductFeedbackBrokerRequest): Promise<ProductFeedbackGrant>;
}

export function productFeedbackRoutes(opts: {
  capability: ProductFeedbackCapability;
  broker?: ProductFeedbackGrantBroker;
}) {
  const router = Router();

  router.post("/product-feedback/grant", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (!opts.capability.enabled) {
      res.status(404).json({ code: "product_feedback_disabled", error: "Product feedback is not enabled." });
      return;
    }

    if (
      req.actor.type !== "board"
      || (req.actor.source !== "session" && req.actor.source !== "local_implicit")
    ) {
      res.status(403).json({ code: "board_session_required", error: "A board session is required." });
      return;
    }

    const parsed = productFeedbackGrantRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "invalid_product_feedback_grant_request",
        error: "The feedback contact request is invalid.",
      });
      return;
    }

    // The open-source product intentionally ships without a production broker
    // credential or browser-selectable trust flag. An operator may advertise
    // and exercise the dialog locally, but submission stays closed until the
    // isolated grant broker is bound by the production host.
    if (!opts.broker) {
      res.status(503).json({
        code: "product_feedback_grant_unavailable",
        error: "Feedback delivery is not available on this instance yet. Your draft is still here.",
      });
      return;
    }

    const brokerRequest: ProductFeedbackBrokerRequest = parsed.data;

    try {
      const grant = productFeedbackGrantSchema.parse(await opts.broker.issueGrant(brokerRequest));
      res.status(201).json(grant);
    } catch {
      res.status(502).json({
        code: "product_feedback_grant_failed",
        error: "Feedback delivery could not start. Your draft is still here. Try again.",
      });
    }
  });

  return router;
}
