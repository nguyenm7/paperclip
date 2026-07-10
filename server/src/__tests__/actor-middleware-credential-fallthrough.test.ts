import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { agentApiKeys, agents, boardApiKeys } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

// Regression tests for LOOA-165: under local_trusted the actor is seeded as
// the implicit board admin before any credential is inspected. Every
// credential-resolution failure used to call next() without resetting that
// actor, so a revoked key, expired run JWT, or terminated agent was silently
// *promoted* to board + instance admin instead of being denied. A presented
// bearer credential that resolves to no principal must yield 401 — never a
// more privileged identity than presenting no credential at all.

function createDb(rowsFor: (table: unknown) => unknown[] = () => []) {
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(rowsFor(table)),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    })),
  } as any;
}

function buildApp(db: any) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

const AGENT_ID = "agent-1";
const COMPANY_ID = "company-1";

describe("actorMiddleware local_trusted credential fall-through (LOOA-165)", () => {
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-jwt-secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
  });

  it("keeps the zero-config implicit board actor when no credential is presented", async () => {
    const res = await request(buildApp(createDb())).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });
  });

  it("rejects an unresolvable bearer token instead of retaining the implicit board actor", async () => {
    // Also covers revoked agent keys: the key lookup filters on revokedAt, so
    // a revoked key resolves to no rows — exactly this path.
    const res = await request(buildApp(createDb()))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_totally_unresolvable");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired credential" });
    expect(res.headers["www-authenticate"]).toContain("invalid_token");
  });

  it("rejects an expired agent run JWT", async () => {
    const realNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(realNow - 2 * 60 * 60 * 1000);
    const expiredJwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", "run-1");
    vi.useRealTimers();
    expect(expiredJwt).toBeTruthy();

    const res = await request(buildApp(createDb()))
      .get("/actor")
      .set("Authorization", `Bearer ${expiredJwt}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired credential" });
  });

  it("rejects a valid run JWT whose agent belongs to a different company", async () => {
    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", "run-1");
    const db = createDb((table) =>
      table === agents ? [{ id: AGENT_ID, companyId: "other-company", status: "active" }] : [],
    );

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(401);
  });

  it("rejects a valid run JWT for a terminated agent", async () => {
    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", "run-1");
    const db = createDb((table) =>
      table === agents ? [{ id: AGENT_ID, companyId: COMPANY_ID, status: "terminated" }] : [],
    );

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(401);
  });

  it("rejects an unrevoked agent key whose agent is terminated", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) return [{ id: "key-1", agentId: AGENT_ID, companyId: COMPANY_ID }];
      if (table === agents) return [{ id: AGENT_ID, companyId: COMPANY_ID, status: "terminated" }];
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_key_for_terminated_agent");

    expect(res.status).toBe(401);
  });

  it("rejects an empty bearer token", async () => {
    // HTTP intermediaries strip trailing whitespace from header values, so
    // exercise the middleware directly to hit the empty-after-trim branch.
    const middleware = actorMiddleware(createDb(), { deploymentMode: "local_trusted" });
    const req = {
      header: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer   " : undefined),
      method: "GET",
      originalUrl: "/actor",
    } as unknown as Request;
    const statusCalls: number[] = [];
    const res = {
      set: () => res,
      status: (code: number) => {
        statusCalls.push(code);
        return res;
      },
      json: () => res,
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCalls).toEqual([401]);
    expect(next).not.toHaveBeenCalled();
    expect(req.actor).toMatchObject({ type: "none", source: "none" });
  });

  it("still resolves a valid run JWT for an active agent", async () => {
    const jwt = createLocalAgentJwt(AGENT_ID, COMPANY_ID, "codex_local", "run-1");
    const db = createDb((table) =>
      table === agents ? [{ id: AGENT_ID, companyId: COMPANY_ID, status: "active" }] : [],
    );

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_jwt",
      runId: "run-1",
    });
  });

  it("rejects an unresolvable bearer token in authenticated mode too", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor").set("Authorization", "Bearer nonsense-token");

    expect(res.status).toBe(401);
  });
});
