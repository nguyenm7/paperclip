import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LOOA-296: the premise-exempt marker silences a stale-gate alarm to the CEO,
// so setting/clearing it is decision-grade: the card's creator agent, the
// company's CEO-role agent, or an authenticated board identity. Unrelated
// agents and bare unauthenticated localhost calls must 403 without mutating.

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  withdraw: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockStaleGateService = vi.hoisted(() => ({
  detect: vi.fn(),
  sweep: vi.fn(),
  setApprovalPremiseExempt: vi.fn(),
  clearApprovalPremiseExempt: vi.fn(),
  setInteractionPremiseExempt: vi.fn(),
  clearInteractionPremiseExempt: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));
  vi.doMock("../services/stale-gate-detector.js", () => ({
    staleGateDetectorService: () => mockStaleGateService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const creatorAgentActor = {
  type: "agent",
  agentId: "agent-creator",
  companyId: "company-1",
  source: "agent_jwt",
  isInstanceAdmin: false,
};

const unrelatedAgentActor = {
  type: "agent",
  agentId: "agent-other",
  companyId: "company-1",
  source: "agent_jwt",
  isInstanceAdmin: false,
};

const ceoAgentActor = {
  type: "agent",
  agentId: "agent-ceo",
  companyId: "company-1",
  source: "agent_jwt",
  isInstanceAdmin: false,
};

const localImplicitActor = {
  type: "board",
  userId: "local-board",
  userName: "Local Board",
  isInstanceAdmin: true,
  source: "local_implicit",
};

const sessionActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
  source: "session",
  isInstanceAdmin: false,
};

const pendingApproval = {
  id: "approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status: "pending",
  payload: {},
  requestedByAgentId: "agent-creator",
};

describe("premise-exempt routes (LOOA-296)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/premise-exempt-authz.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/stale-gate-detector.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    for (const fn of Object.values(mockApprovalService)) fn.mockReset();
    for (const fn of Object.values(mockStaleGateService)) fn.mockReset();
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(pendingApproval);
    mockStaleGateService.setApprovalPremiseExempt.mockResolvedValue({
      ...pendingApproval,
      premiseExemptAt: new Date(),
    });
    mockStaleGateService.clearApprovalPremiseExempt.mockResolvedValue(pendingApproval);
  });

  it("lets the card's creator agent set the exempt marker and audit-logs it", async () => {
    const res = await request(await createApp(creatorAgentActor))
      .post("/api/approvals/approval-1/premise-exempt")
      .send({ reason: "record-keeping per CEO ruling" });

    expect(res.status).toBe(200);
    expect(mockStaleGateService.setApprovalPremiseExempt).toHaveBeenCalledWith(
      "approval-1",
      "record-keeping per CEO ruling",
      { agentId: "agent-creator", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.premise_exempt_set", agentId: "agent-creator" }),
    );
  });

  it("rejects an unrelated agent with 403 and does not mutate", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-other",
      companyId: "company-1",
      role: "general",
    });

    const res = await request(await createApp(unrelatedAgentActor))
      .post("/api/approvals/approval-1/premise-exempt")
      .send({ reason: "silence it" });

    expect(res.status).toBe(403);
    expect(mockStaleGateService.setApprovalPremiseExempt).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.premise_exempt_set" }),
    );
  });

  it("lets the company CEO-role agent set the exempt marker (the alarm recipient silencing their own alarm)", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-1",
      role: "ceo",
    });

    const res = await request(await createApp(ceoAgentActor))
      .post("/api/approvals/approval-1/premise-exempt")
      .send({});

    expect(res.status).toBe(200);
    expect(mockStaleGateService.setApprovalPremiseExempt).toHaveBeenCalledWith(
      "approval-1",
      null,
      { agentId: "agent-ceo", userId: null },
    );
  });

  it("rejects a CEO-role agent from a different company", async () => {
    mockApprovalService.getById.mockResolvedValue({
      ...pendingApproval,
      companyId: "company-1",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-ceo",
      companyId: "company-2",
      role: "ceo",
    });
    const foreignCeo = { ...ceoAgentActor, companyId: "company-1" };

    const res = await request(await createApp(foreignCeo))
      .post("/api/approvals/approval-1/premise-exempt")
      .send({});

    expect(res.status).toBe(403);
    expect(mockStaleGateService.setApprovalPremiseExempt).not.toHaveBeenCalled();
  });

  it("lets an authenticated board session set and clear the marker", async () => {
    const app = await createApp(sessionActor);
    const setRes = await request(app)
      .post("/api/approvals/approval-1/premise-exempt")
      .send({ reason: "deliberate record-keeping" });
    expect(setRes.status).toBe(200);
    expect(mockStaleGateService.setApprovalPremiseExempt).toHaveBeenCalledWith(
      "approval-1",
      "deliberate record-keeping",
      { agentId: null, userId: "user-1" },
    );

    const clearRes = await request(app).delete("/api/approvals/approval-1/premise-exempt");
    expect(clearRes.status).toBe(200);
    expect(mockStaleGateService.clearApprovalPremiseExempt).toHaveBeenCalledWith("approval-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.premise_exempt_cleared" }),
    );
  });

  it("rejects bare unauthenticated localhost calls (no browser origin)", async () => {
    const res = await request(await createApp(localImplicitActor))
      .post("/api/approvals/approval-1/premise-exempt")
      .send({});

    expect(res.status).toBe(403);
    expect(mockStaleGateService.setApprovalPremiseExempt).not.toHaveBeenCalled();
  });

  it("clearing is held to the same authz bar as setting", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-other",
      companyId: "company-1",
      role: "general",
    });

    const res = await request(await createApp(unrelatedAgentActor)).delete(
      "/api/approvals/approval-1/premise-exempt",
    );

    expect(res.status).toBe(403);
    expect(mockStaleGateService.clearApprovalPremiseExempt).not.toHaveBeenCalled();
  });
});
