import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, boardApiKeys, heartbeatRuns } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

// Regression tests for LOOA-303: an agent process whose shell environment
// picked up a stale/foreign PAPERCLIP_API_KEY (a profile-exported static key
// for another company's agent overrode the injected run JWT during a
// process_lost_retry heartbeat) could authenticate as that other agent while
// stamping its writes with the current run's X-Paperclip-Run-Id. The header
// was trusted unvalidated, so the mismatch produced silent cross-company
// impersonation with corrupted audit attribution. Agent credentials carrying
// a run id header must now prove the run belongs to the same agent and
// company — anything else fails closed.

const RUN_AGENT_ID = "agent-rook";
const RUN_COMPANY_ID = "company-loops";
const RUN_ID = "run-looa-299-retry";
const FOREIGN_AGENT_ID = "agent-meredian";
const FOREIGN_COMPANY_ID = "company-agentsy";

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

describe("actorMiddleware run-id ↔ credential identity binding (LOOA-303)", () => {
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-jwt-secret";
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
  });

  it("rejects a static agent key from another company presented with this run's id (the LOOA-303 incident shape)", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) {
        return [{ id: "key-1", agentId: FOREIGN_AGENT_ID, companyId: FOREIGN_COMPANY_ID }];
      }
      if (table === agents) {
        return [{ id: FOREIGN_AGENT_ID, companyId: FOREIGN_COMPANY_ID, status: "active" }];
      }
      if (table === heartbeatRuns) {
        return [{ agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_static_key_from_zshrc")
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Credential identity does not match the run in X-Paperclip-Run-Id" });
  });

  it("rejects a run JWT presented with a run id that belongs to a different agent", async () => {
    const jwt = createLocalAgentJwt(FOREIGN_AGENT_ID, FOREIGN_COMPANY_ID, "codex_local", "run-foreign");
    const db = createDb((table) => {
      if (table === agents) {
        return [{ id: FOREIGN_AGENT_ID, companyId: FOREIGN_COMPANY_ID, status: "active" }];
      }
      if (table === heartbeatRuns) {
        return [{ agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${jwt}`)
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(403);
  });

  it("rejects an agent credential whose run id header resolves to no run at all", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) {
        return [{ id: "key-1", agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      if (table === agents) {
        return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      }
      if (table === heartbeatRuns) return [];
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_key")
      .set("X-Paperclip-Run-Id", "run-that-does-not-exist");

    expect(res.status).toBe(403);
  });

  it("rejects, not errors, when the run id is malformed and the database lookup throws", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) {
        return [{ id: "key-1", agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      if (table === agents) {
        return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      }
      if (table === heartbeatRuns) {
        throw new Error("invalid input syntax for type uuid");
      }
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_key")
      .set("X-Paperclip-Run-Id", "not-a-uuid");

    expect(res.status).toBe(403);
  });

  it("accepts an agent static key whose run id belongs to that same agent", async () => {
    const db = createDb((table) => {
      if (table === boardApiKeys) return [];
      if (table === agentApiKeys) {
        return [{ id: "key-1", agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      if (table === agents) {
        return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      }
      if (table === heartbeatRuns) {
        return [{ agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", "Bearer pcp_agent_key")
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: RUN_AGENT_ID,
      companyId: RUN_COMPANY_ID,
      runId: RUN_ID,
      source: "agent_key",
    });
  });

  it("accepts a run JWT with its own run's id in the header", async () => {
    const jwt = createLocalAgentJwt(RUN_AGENT_ID, RUN_COMPANY_ID, "codex_local", RUN_ID);
    const db = createDb((table) => {
      if (table === agents) {
        return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      }
      if (table === heartbeatRuns) {
        return [{ agentId: RUN_AGENT_ID, companyId: RUN_COMPANY_ID }];
      }
      return [];
    });

    const res = await request(buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${jwt}`)
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: RUN_AGENT_ID,
      companyId: RUN_COMPANY_ID,
      runId: RUN_ID,
      source: "agent_jwt",
    });
  });

  it("still resolves agent credentials normally when no run id header is present", async () => {
    const jwt = createLocalAgentJwt(RUN_AGENT_ID, RUN_COMPANY_ID, "codex_local", RUN_ID);
    const db = createDb((table) => {
      if (table === agents) {
        return [{ id: RUN_AGENT_ID, companyId: RUN_COMPANY_ID, status: "active" }];
      }
      return [];
    });

    const res = await request(buildApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId: RUN_AGENT_ID, runId: RUN_ID });
  });

  it("leaves board actors untouched by run id binding (local-trusted recovery path)", async () => {
    // The incident recovery deliberately used the implicit local board actor
    // with X-Paperclip-Run-Id for attribution; run binding is an agent-only
    // check and must not lock the board out of run-attributed writes.
    const res = await request(buildApp(createDb()))
      .get("/actor")
      .set("X-Paperclip-Run-Id", RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      runId: RUN_ID,
    });
  });
});
