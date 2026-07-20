import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  setPremiseExemptSchema,
  withdrawApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
// Imported directly (not via the services index) so the many test suites that
// mock ../services/index.js with a partial factory keep working; these are
// only exercised by the premise-exempt routes.
import { agentService } from "../services/agents.js";
import { staleGateDetectorService } from "../services/stale-gate-detector.js";
import {
  assertApprovalDecisionActor,
  assertCompanyAccess,
  getActorInfo,
} from "./authz.js";
import { forbidden } from "../errors.js";
import { assertPremiseExemptActor } from "./premise-exempt-authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

// Duck-typed on status so it also matches HttpError instances from a
// different module registry copy (as under vitest module resets).
function isForbiddenError(err: unknown): boolean {
  return err instanceof Error && (err as { status?: unknown }).status === 403;
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const staleGates = staleGateDetectorService(db, {
    wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
  });
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  // LOOA-259: a denied decide/withdraw attempt is the observable precursor of
  // exactly the forgery the LOOA-231 boundary exists to prevent, so the denial
  // must reach the activity ledger instead of vanishing with the 403.
  // Failure-closed both ways: the 403 never depends on the log write
  // succeeding, and the log write never swallows the 403.
  async function logDeniedApprovalAttempt(
    req: Request,
    approvalId: string,
    action: "approval.decision_denied" | "approval.withdraw_denied",
    route: "approve" | "reject" | "request-revision" | "withdraw",
  ) {
    try {
      const approval = await svc.getById(approvalId);
      // The ledger is company-scoped; when the target approval does not
      // exist, an agent actor's own company still gives the row a home.
      const companyId =
        approval?.companyId ?? (req.actor.type === "agent" ? req.actor.companyId ?? null : null);
      if (!companyId) {
        logger.warn(
          { approvalId, route, actorType: req.actor.type, actorSource: req.actor.source },
          "denied approval attempt had no company to log against",
        );
        return;
      }
      const agentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;
      const actorId = agentId ?? req.actor.userId ?? "unauthenticated";
      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId,
        agentId,
        runId: req.actor.runId ?? null,
        action,
        entityType: "approval",
        entityId: approvalId,
        details: {
          route,
          actorType: req.actor.type,
          actorId,
          actorSource: req.actor.source ?? null,
          hadOrigin: Boolean(req.header("origin")),
          hadReferer: Boolean(req.header("referer")),
        },
      });
    } catch (err) {
      logger.warn({ err, approvalId, route }, "failed to audit-log denied approval attempt");
    }
  }

  async function assertDecisionActorLogged(
    req: Request,
    approvalId: string,
    route: "approve" | "reject" | "request-revision",
  ) {
    try {
      return assertApprovalDecisionActor(req);
    } catch (err) {
      if (isForbiddenError(err)) {
        await logDeniedApprovalAttempt(req, approvalId, "approval.decision_denied", route);
      }
      throw err;
    }
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const decisionSource = await assertDecisionActorLogged(req, id, "approve");
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.approve(
      id,
      decidedByUserId,
      req.body.decisionNote,
      decisionSource,
    );

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const decisionSource = await assertDecisionActorLogged(req, id, "reject");
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(
      id,
      decidedByUserId,
      req.body.decisionNote,
      decisionSource,
    );

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  // Agent-callable retraction of the agent's own card — the safe primitive
  // whose absence pushed agents onto the unauthenticated decide route
  // (LOOA-231). Records status "withdrawn" with withdrawn_by_agent_id/at and
  // never touches decided_by_* — a withdrawal is not a board decision.
  router.post("/approvals/:id/withdraw", validate(withdrawApprovalSchema), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden(
        "Withdraw is the agent-requester primitive; board members decide with approve/reject instead.",
      );
    }
    const id = req.params.id as string;
    const existing = await requireApprovalAccess(req, id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const agentId = req.actor.agentId;
    let result: Awaited<ReturnType<typeof svc.withdraw>>;
    try {
      result = await svc.withdraw(id, agentId);
    } catch (err) {
      // Ownership 403 only — status-gate 422s are workflow noise, not a
      // takeover attempt on someone else's card.
      if (isForbiddenError(err)) {
        await logDeniedApprovalAttempt(req, id, "approval.withdraw_denied", "withdraw");
      }
      throw err;
    }
    const { approval, applied } = result;

    if (applied) {
      const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
      if (reason) {
        await svc.addComment(id, `Withdrawn by requester: ${reason}`, { agentId });
      }

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "approval.withdrawn",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, reason: reason || null },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  // LOOA-296 stale-gate detector: premise-exempt marker. A card deliberately
  // left pending on a done/cancelled source issue (record-keeping) is marked
  // exempt so the detector never alarms the CEO about it. Exempting silences
  // an alarm, so it carries decision-grade authz: the card's creator agent,
  // the company's CEO agent (the alarm's recipient), or an authenticated
  // board identity. Clearing the mark re-arms the card.
  router.post(
    "/approvals/:id/premise-exempt",
    validate(setPremiseExemptSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await requireApprovalAccess(req, id);
      if (!existing) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const actor = await assertPremiseExemptActor(
        req,
        { companyId: existing.companyId, createdByAgentId: existing.requestedByAgentId ?? null },
        (lookupId) => agentService(db).getById(lookupId),
      );
      const reason =
        typeof req.body.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null;
      const updated = await staleGates.setApprovalPremiseExempt(id, reason, actor);
      if (!updated) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.agentId ? "agent" : "user",
        actorId: actor.agentId ?? actor.userId ?? "board",
        agentId: actor.agentId,
        action: "approval.premise_exempt_set",
        entityType: "approval",
        entityId: id,
        details: { type: existing.type, reason },
      });
      res.json(redactApprovalPayload(updated));
    },
  );

  router.delete("/approvals/:id/premise-exempt", async (req, res) => {
    const id = req.params.id as string;
    const existing = await requireApprovalAccess(req, id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const actor = await assertPremiseExemptActor(
      req,
      { companyId: existing.companyId, createdByAgentId: existing.requestedByAgentId ?? null },
      (lookupId) => agentService(db).getById(lookupId),
    );
    const updated = await staleGates.clearApprovalPremiseExempt(id);
    if (!updated) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.agentId ? "agent" : "user",
      actorId: actor.agentId ?? actor.userId ?? "board",
      agentId: actor.agentId,
      action: "approval.premise_exempt_cleared",
      entityType: "approval",
      entityId: id,
      details: { type: existing.type },
    });
    res.json(redactApprovalPayload(updated));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const decisionSource = await assertDecisionActorLogged(req, id, "request-revision");
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(
        id,
        decidedByUserId,
        req.body.decisionNote,
        decisionSource,
      );

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
