import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LOOA-231: board decisions must carry an authenticated identity. Agents and
// bare unauthenticated localhost calls must 403 on approve/reject; the only
// agent-callable mutation is withdrawing the agent's own card, which is
// recorded as "withdrawn" and never as a decision.

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

const agentActor = {
  type: "agent",
  agentId: "agent-1",
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
  requestedByAgentId: "agent-1",
};

describe("approval decision authentication (LOOA-231)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    for (const fn of Object.values(mockApprovalService)) fn.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(pendingApproval);
  });

  it("rejects agent JWTs on approve with 403 and points at withdraw", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("withdraw");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects agent JWTs on reject with 403", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
  });

  it("rejects bare unauthenticated localhost calls (no browser origin) on approve", async () => {
    const res = await request(await createApp(localImplicitActor))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects bare unauthenticated localhost calls on reject", async () => {
    const res = await request(await createApp(localImplicitActor))
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
  });

  it("rejects bare unauthenticated localhost calls on request-revision", async () => {
    const res = await request(await createApp(localImplicitActor))
      .post("/api/approvals/approval-1/request-revision")
      .send({ decisionNote: "changes" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("accepts local_implicit decisions from a trusted browser origin and records that provenance", async () => {
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...pendingApproval, status: "rejected" },
      applied: true,
    });

    const res = await request(await createApp(localImplicitActor))
      .post("/api/approvals/approval-1/reject")
      .set("Origin", "http://localhost:3100")
      .send({ decisionNote: "no" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith(
      "approval-1",
      "local-board",
      "no",
      "local_implicit_browser",
    );
  });

  it("records session provenance for authenticated board decisions", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pendingApproval, status: "approved" },
      applied: true,
    });

    const res = await request(await createApp(sessionActor))
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith(
      "approval-1",
      "user-1",
      undefined,
      "session",
    );
  });

  it("lets an agent withdraw its own card and logs it as a withdrawal, not a decision", async () => {
    mockApprovalService.withdraw.mockResolvedValue({
      approval: {
        ...pendingApproval,
        status: "withdrawn",
        withdrawnByAgentId: "agent-1",
        withdrawnAt: new Date("2026-07-13T00:00:00.000Z"),
      },
      applied: true,
    });

    const res = await request(await createApp(agentActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "Created in error by an API schema probe" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith("approval-1", "agent-1");
    expect(mockApprovalService.addComment).toHaveBeenCalledWith(
      "approval-1",
      "Withdrawn by requester: Created in error by an API schema probe",
      { agentId: "agent-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.withdrawn",
      }),
    );
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
  });

  it("does not log or comment when withdraw converges on an already-withdrawn card", async () => {
    mockApprovalService.withdraw.mockResolvedValue({
      approval: { ...pendingApproval, status: "withdrawn" },
      applied: false,
    });

    const res = await request(await createApp(agentActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "retry" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects withdraw from board actors", async () => {
    const res = await request(await createApp(sessionActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });

  it("rejects withdraw from agents of another company", async () => {
    mockApprovalService.getById.mockResolvedValue({
      ...pendingApproval,
      companyId: "company-2",
    });

    const res = await request(await createApp(agentActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  });
});
