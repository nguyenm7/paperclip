import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it", "session");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now", "session");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it", "session");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });
});

describe("approvalService withdraw (LOOA-231)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.terminate.mockResolvedValue(undefined);
  });

  it("refuses to withdraw a card the agent did not create", async () => {
    const dbStub = createDbStub([[createApproval("pending")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", "someone-else")).rejects.toThrow(
      "Agents may only withdraw approvals they created",
    );
  });

  it("withdraws the requester's own pending card without writing decision fields", async () => {
    const withdrawn = {
      ...createApproval("withdrawn"),
      withdrawnByAgentId: "requester-1",
    };
    const dbStub = createDbStub([[createApproval("pending")]], [withdrawn]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", "requester-1");

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("withdrawn");
    // hire_agent card: the pending placeholder agent is released like a reject
    expect(mockAgentService.terminate).toHaveBeenCalledWith("agent-1");
  });

  it("converges as a no-op when the card is already withdrawn", async () => {
    const dbStub = createDbStub([[createApproval("withdrawn")]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", "requester-1");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("withdrawn");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("refuses to withdraw a decided card", async () => {
    const dbStub = createDbStub([[createApproval("approved")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", "requester-1")).rejects.toThrow(
      "Only pending or revision requested approvals can be withdrawn",
    );
  });
});
