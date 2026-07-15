import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { healthRoutes } from "../routes/health.js";

function appWith(opts: Parameters<typeof healthRoutes>[1]) {
  const app = express();
  app.use("/health", healthRoutes(undefined, opts));
  return app;
}

describe("GET /health servingTree (LOOA-389)", () => {
  const base = {
    deploymentMode: "local_trusted" as const,
    deploymentExposure: "private" as const,
    authReady: true,
    companyDeletionEnabled: true,
  };

  it("exposes the served commit when full details are shown", async () => {
    const app = appWith({ ...base, servingCommit: { head: "a".repeat(40), branch: "master" } });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.servingTree).toEqual({ head: "a".repeat(40), branch: "master" });
  });

  it("omits servingTree entirely when the commit is unknown", async () => {
    const app = appWith({ ...base, servingCommit: null });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("servingTree");
  });

  it("does not leak the served commit to unauthenticated callers in authenticated mode", async () => {
    const app = appWith({
      ...base,
      deploymentMode: "authenticated",
      servingCommit: { head: "b".repeat(40), branch: "master" },
    });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    // No actor -> not full details -> served commit withheld, like `version`.
    expect(res.body).not.toHaveProperty("servingTree");
    expect(res.body).not.toHaveProperty("version");
  });
});
