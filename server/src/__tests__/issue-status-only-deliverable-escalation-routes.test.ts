import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LOOA-175 regression: a cheap status-only recovery run that 403s on a
// deliverable write must schedule exactly one normal-model escalation wake so
// the pending write reaches a run that is permitted to perform it, and the 403
// body must name that escalation path.

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const statusOnlyRunContext = {
  modelProfile: "cheap",
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  listIssueDocuments: vi.fn(),
  listIssueDocumentRevisions: vi.fn(),
  restoreIssueDocumentRevision: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => ({ id: "escalation-run-1" })),
  reportRunActivity: vi.fn(async () => undefined),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  getExperimental: vi.fn(async () => ({})),
  getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
  listCompanyIds: vi.fn(async () => [companyId]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentsService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentsService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

// Minimal db stub for the two guard queries: the heartbeatRuns context lookup
// resolves through .where().then(), the agentWakeupRequests dedupe lookup
// resolves through .where().limit(1).then().
function createGuardDb(input: {
  runContextSnapshot: Record<string, unknown>;
  existingWakeRows?: unknown[];
}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve([{
              id: "run-1",
              companyId,
              agentId: "agent-1",
              contextSnapshot: input.runContextSnapshot,
            }]),
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) =>
              resolve(input.existingWakeRows ?? []),
          })),
        })),
      })),
    })),
  };
}

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId,
  runId: "run-1",
  source: "agent_jwt",
} as const;

async function createApp(db: unknown) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = agentActor;
    next();
  });
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("status-only recovery deliverable write escalation (LOOA-175)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:mutate",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-900",
      title: "Ledger write",
      status: "todo",
      assigneeAgentId: "agent-1",
    });
    mockDocumentsService.restoreIssueDocumentRevision.mockResolvedValue({
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      document: {
        id: "document-1",
        companyId,
        issueId,
        key: "plan",
        title: "Plan v1",
        format: "markdown",
        body: "# One",
        latestRevisionId: "revision-3",
        latestRevisionNumber: 3,
        createdByAgentId: "agent-1",
        createdByUserId: null,
        updatedByAgentId: "agent-1",
        updatedByUserId: null,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:10:00.000Z"),
      },
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "escalation-run-1" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("403s the deliverable write, schedules exactly one normal-model wake, and names the escalation path", async () => {
    const app = await createApp(createGuardDb({ runContextSnapshot: statusOnlyRunContext }));

    const res = await request(app)
      .put(`/api/issues/${issueId}/documents/findings`)
      .send({ title: "Findings", format: "markdown", body: "# Findings" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot update issue documents");
    expect(res.body.details.escalation).toMatchObject({
      outcome: "scheduled",
      wakeReason: "recovery_deliverable_write_escalation",
      idempotencyKey: `recovery_deliverable_write_escalation:${issueId}:run-1`,
    });
    expect(res.body.details.escalation.path).toContain("normal-model wake");

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    const [wakeAgentId, wakeOpts] = mockHeartbeatService.wakeup.mock.calls[0] as [string, Record<string, any>];
    expect(wakeAgentId).toBe("agent-1");
    expect(wakeOpts.reason).toBe("recovery_deliverable_write_escalation");
    expect(wakeOpts.idempotencyKey).toBe(`recovery_deliverable_write_escalation:${issueId}:run-1`);
    // The follow-up wake must be a normal-model run: no cheap hints anywhere.
    for (const snapshot of [wakeOpts.payload, wakeOpts.contextSnapshot]) {
      expect(snapshot.modelProfile).toBeUndefined();
      expect(snapshot.recoveryIntent).toBeUndefined();
      expect(snapshot.allowDocumentUpdates).toBeUndefined();
    }
    expect(wakeOpts.payload.deniedMutation).toMatchObject({
      method: "PUT",
      path: `/api/issues/${issueId}/documents/findings`,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.deliverable_write_escalation_scheduled" }),
    );
  });

  it("does not enqueue a second wake for the same source run", async () => {
    const app = await createApp(createGuardDb({
      runContextSnapshot: statusOnlyRunContext,
      existingWakeRows: [{ id: "wake-1", status: "queued" }],
    }));

    const res = await request(app)
      .put(`/api/issues/${issueId}/documents/findings`)
      .send({ format: "markdown", body: "# Findings" });

    expect(res.status).toBe(403);
    expect(res.body.details.escalation.outcome).toBe("already_scheduled");
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still fails closed with 403 when scheduling the escalation wake fails", async () => {
    mockHeartbeatService.wakeup.mockRejectedValue(new Error("wake enqueue exploded"));
    const app = await createApp(createGuardDb({ runContextSnapshot: statusOnlyRunContext }));

    const res = await request(app)
      .put(`/api/issues/${issueId}/documents/findings`)
      .send({ format: "markdown", body: "# Findings" });

    expect(res.status).toBe(403);
    expect(res.body.details.escalation.outcome).toBe("failed");
    expect(res.body.details.escalation.path).toContain("normal-model wake");
  });

  it("permits the deliverable write on the follow-up run once the cheap hints are scrubbed", async () => {
    // A normal-model escalation run carries a scrubbed context snapshot, so the
    // same guard lets the write through.
    const app = await createApp(createGuardDb({
      runContextSnapshot: { issueId, wakeReason: "recovery_deliverable_write_escalation" },
    }));

    const res = await request(app)
      .post(`/api/issues/${issueId}/documents/plan/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockDocumentsService.restoreIssueDocumentRevision).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
