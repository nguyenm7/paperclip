import type { Request } from "express";
import type { ApprovalDecisionSource } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import { isTrustedBoardMutationRequest } from "../middleware/board-mutation-guard.js";

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

/**
 * Gate for board decision writes (approval approve/reject/request-revision).
 *
 * A decision row asserts "a human decided this", so it demands more than
 * assertBoard: agents are rejected outright (withdraw is their primitive for
 * retracting their own cards), and the local_trusted implicit admin — which
 * any process with localhost access can invoke via bare curl, making a human
 * and an agent byte-identical in the ledger (LOOA-231) — is only accepted
 * when the request is browser-shaped (trusted Origin/Referer, which the
 * board UI always sends and a bare API call does not).
 *
 * Returns the provenance label persisted with the decision. local_trusted
 * mode has no authenticated identity, so `local_implicit_browser` is a
 * weaker claim than `session`/`board_key` — readers must treat it as
 * "browser-shaped", not "cryptographically human".
 */
export function assertApprovalDecisionActor(req: Request): ApprovalDecisionSource {
  if (req.actor.type === "agent") {
    throw forbidden(
      "Agents cannot decide board approvals. To retract a card you created, use POST /api/approvals/{id}/withdraw; otherwise ask a board member to decide.",
    );
  }
  assertBoard(req);
  switch (req.actor.source) {
    case "session":
      return "session";
    case "board_key":
      return "board_key";
    case "cloud_tenant":
      return "cloud_tenant";
    case "local_implicit":
      if (isTrustedBoardMutationRequest(req)) {
        return "local_implicit_browser";
      }
      throw forbidden(
        "Board decisions require an authenticated identity; the unauthenticated localhost route cannot decide approvals. Decide from the board UI or with a board API key. Agents can withdraw their own cards via POST /api/approvals/{id}/withdraw.",
      );
    default:
      throw forbidden("Board decisions require an authenticated board identity");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

export function getActorInfo(req: Request) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
