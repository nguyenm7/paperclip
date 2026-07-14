import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      return createSelectChain(selectCallCount === 1 ? [interactionRow] : (args.parentRows ?? []));
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionUpdates.push(values);
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error(`Unexpected update target: ${String(table)}`);
          },
        };
      },
    })),
    insert: vi.fn(),
    transaction: async (callback: (tx: typeof db) => Promise<void>) => callback(db),
  };

  return {
    db,
    getInteractionRow: () => interactionRow,
    issueTouches,
    interactionUpdates,
  };
}

describe("issueThreadInteractionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("create reuses an existing interaction for the same idempotency key", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const existingRow = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      sourceCommentId: null,
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const db: any = {
      select: vi.fn(() => createSelectChain([existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-1");
    expect(created.idempotencyKey).toBe("run-1:suggest");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("answerQuestions normalizes duplicate option ids and persists answered results", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const interactionRow = {
      id: "interaction-2",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Pick extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.answerQuestions({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, "interaction-2", {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(result.status).toBe("answered");
    expect(result.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    });
    expect(state.interactionUpdates).toHaveLength(1);
    expect(state.issueTouches).toHaveLength(1);
  });

  // LOOA-294: creator withdraw — the agent-side retraction primitive. These
  // mirror the approval withdraw semantics (LOOA-231): creator-only, never a
  // board decision, idempotent on re-withdraw, conflict on any other terminal.
  describe("withdrawInteraction", () => {
    const ISSUE_REF = { id: "11111111-1111-4111-8111-111111111111", companyId: "company-1" };

    function confirmationRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "interaction-3",
        companyId: "company-1",
        issueId: ISSUE_REF.id,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: null,
        title: "Confirm the thing",
        summary: null,
        createdByAgentId: "agent-1",
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        payload: {
          version: 1,
          prompt: "Confirm?",
          supersedeOnUserComment: true,
        },
        result: null,
        resolvedAt: null,
        createdAt: new Date("2026-04-20T10:00:00.000Z"),
        updatedAt: new Date("2026-04-20T10:00:00.000Z"),
        ...overrides,
      };
    }

    it("lets the creator agent withdraw a pending confirmation without recording a board decision", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      const svc = issueThreadInteractionService(state.db as never);

      const { interaction, applied } = await svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        { reason: "The world changed under this card" },
        { agentId: "agent-1" },
      );

      expect(applied).toBe(true);
      expect(interaction.status).toBe("withdrawn");
      expect(interaction.result).toEqual({
        version: 1,
        outcome: "withdrawn_by_creator",
        reason: "The world changed under this card",
      });
      expect(interaction.resolvedByAgentId).toBe("agent-1");
      expect(interaction.resolvedByUserId).toBeNull();
      expect(state.interactionUpdates).toHaveLength(1);
      expect(state.issueTouches).toHaveLength(1);
    });

    it("records withdrawnReason for ask_user_questions withdrawals", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "scope",
                prompt: "Pick one scope",
                selectionMode: "single",
                options: [{ id: "phase-1", label: "Phase 1" }],
              },
            ],
          },
        }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      const { interaction, applied } = await svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        { reason: "Question no longer applies" },
        { agentId: "agent-1" },
      );

      expect(applied).toBe(true);
      expect(interaction.status).toBe("withdrawn");
      expect(interaction.result).toEqual({
        version: 1,
        answers: [],
        withdrawnReason: "Question no longer applies",
      });
      expect(interaction.resolvedByUserId).toBeNull();
    });

    it("rejects non-creator agents with 403", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { agentId: "agent-2" },
      )).rejects.toMatchObject({ status: 403 });
      expect(state.interactionUpdates).toHaveLength(0);
    });

    it("rejects actors without an agent identity with 403", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { userId: "local-board" },
      )).rejects.toMatchObject({ status: 403 });
      expect(state.interactionUpdates).toHaveLength(0);
    });

    it("rejects board-created interactions even for the resolving agent", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({ createdByAgentId: null, createdByUserId: "local-board" }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { agentId: "agent-1" },
      )).rejects.toMatchObject({ status: 403 });
    });

    it("conflicts on interactions already resolved by the board", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({
          status: "accepted",
          resolvedByUserId: "local-board",
          result: { version: 1, outcome: "accepted" },
        }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { agentId: "agent-1" },
      )).rejects.toMatchObject({ status: 409 });
      expect(state.interactionUpdates).toHaveLength(0);
    });

    it("converges without a second write when the card is already withdrawn", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({
          status: "withdrawn",
          resolvedByAgentId: "agent-1",
          result: { version: 1, outcome: "withdrawn_by_creator", reason: null },
          resolvedAt: new Date("2026-04-20T11:00:00.000Z"),
        }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      const { interaction, applied } = await svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { agentId: "agent-1" },
      );

      expect(applied).toBe(false);
      expect(interaction.status).toBe("withdrawn");
      expect(state.interactionUpdates).toHaveLength(0);
      expect(state.issueTouches).toHaveLength(0);
    });

    it("withdraws a pending checkbox confirmation with the shared confirmation outcome", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({
          kind: "request_checkbox_confirmation",
          payload: {
            version: 1,
            prompt: "Pick the files to delete",
            options: [{ id: "file-1", label: "File 1" }],
            defaultSelectedOptionIds: [],
            minSelected: 0,
            allowDeclineReason: true,
          },
        }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      const { interaction, applied } = await svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        { reason: "The option list is stale" },
        { agentId: "agent-1" },
      );

      expect(applied).toBe(true);
      expect(interaction.status).toBe("withdrawn");
      // The checkbox result schema must accept a withdrawal without
      // selectedOptionIds — hydration re-parses this on every later read.
      expect(interaction.result).toEqual({
        version: 1,
        outcome: "withdrawn_by_creator",
        reason: "The option list is stale",
      });
      expect(interaction.resolvedByUserId).toBeNull();
    });

    it("fails closed with 409 when a concurrent resolution wins the pending-guarded update", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({ interactionRow: confirmationRow() });
      // Double-withdraw race: the pre-check reads a pending row, but another
      // request resolves the card before this one's guarded UPDATE runs, so
      // the status = 'pending' predicate matches zero rows.
      state.db.update = vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      }));
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { agentId: "agent-1" },
      )).rejects.toMatchObject({ status: 409 });
    });

    it("returns 404 for interactions on another issue", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const state = createFakeDb({
        interactionRow: confirmationRow({ issueId: "99999999-9999-4999-8999-999999999999" }),
      });
      const svc = issueThreadInteractionService(state.db as never);

      await expect(svc.withdrawInteraction(
        ISSUE_REF,
        "interaction-3",
        {},
        { agentId: "agent-1" },
      )).rejects.toMatchObject({ status: 404 });
    });

    // LOOA-320: manager-chain escalation — who can retract a gate when its
    // creator can't. The creator's reportsTo ancestors are fallback
    // principals; everyone else (peers, the creator's own reports) stays 403.
    describe("manager-chain escalation", () => {
      const COMPANY_AGENTS = [
        { id: "agent-ceo", companyId: "company-1", name: "CEO", status: "active", reportsTo: null },
        { id: "agent-manager", companyId: "company-1", name: "Manager", status: "active", reportsTo: "agent-ceo" },
        { id: "agent-1", companyId: "company-1", name: "Creator", status: "active", reportsTo: "agent-manager" },
        { id: "agent-peer", companyId: "company-1", name: "Peer", status: "active", reportsTo: "agent-manager" },
        { id: "agent-report", companyId: "company-1", name: "Report", status: "active", reportsTo: "agent-1" },
      ];

      it("lets the creator's direct manager withdraw with a distinct escalation outcome", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: COMPANY_AGENTS });
        const svc = issueThreadInteractionService(state.db as never);

        const { interaction, applied } = await svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          { reason: "Creator cannot run; retracting on its behalf" },
          { agentId: "agent-manager" },
        );

        expect(applied).toBe(true);
        expect(interaction.status).toBe("withdrawn");
        expect(interaction.result).toEqual({
          version: 1,
          outcome: "withdrawn_by_manager",
          reason: "Creator cannot run; retracting on its behalf",
        });
        expect(interaction.resolvedByAgentId).toBe("agent-manager");
        expect(interaction.resolvedByUserId).toBeNull();
      });

      it("lets a transitive reportsTo ancestor withdraw", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: COMPANY_AGENTS });
        const svc = issueThreadInteractionService(state.db as never);

        const { interaction, applied } = await svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          {},
          { agentId: "agent-ceo" },
        );

        expect(applied).toBe(true);
        expect(interaction.result).toMatchObject({ outcome: "withdrawn_by_manager" });
        expect(interaction.resolvedByAgentId).toBe("agent-ceo");
      });

      it("records escalation in the resolved actor for kinds without an outcome field", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        const state = createFakeDb({
          interactionRow: confirmationRow({
            kind: "ask_user_questions",
            payload: {
              version: 1,
              questions: [{
                id: "scope",
                prompt: "Pick one scope",
                selectionMode: "single",
                options: [{ id: "phase-1", label: "Phase 1" }],
              }],
            },
          }),
          parentRows: COMPANY_AGENTS,
        });
        const svc = issueThreadInteractionService(state.db as never);

        const { interaction, applied } = await svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          { reason: "Question is stranded" },
          { agentId: "agent-manager" },
        );

        expect(applied).toBe(true);
        expect(interaction.result).toEqual({
          version: 1,
          answers: [],
          withdrawnReason: "Question is stranded",
        });
        expect(interaction.resolvedByAgentId).toBe("agent-manager");
      });

      it("rejects a peer that shares the creator's manager with 403", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: COMPANY_AGENTS });
        const svc = issueThreadInteractionService(state.db as never);

        await expect(svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          {},
          { agentId: "agent-peer" },
        )).rejects.toMatchObject({ status: 403 });
        expect(state.interactionUpdates).toHaveLength(0);
      });

      it("rejects the creator's own report — escalation only goes up the chain", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: COMPANY_AGENTS });
        const svc = issueThreadInteractionService(state.db as never);

        await expect(svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          {},
          { agentId: "agent-report" },
        )).rejects.toMatchObject({ status: 403 });
        expect(state.interactionUpdates).toHaveLength(0);
      });

      it("still authorizes ancestors below a reporting cycle without looping", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        const cyclicalAgents = [
          { id: "agent-a", companyId: "company-1", name: "A", status: "active", reportsTo: "agent-b" },
          { id: "agent-b", companyId: "company-1", name: "B", status: "active", reportsTo: "agent-a" },
          { id: "agent-1", companyId: "company-1", name: "Creator", status: "active", reportsTo: "agent-a" },
        ];
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: cyclicalAgents });
        const svc = issueThreadInteractionService(state.db as never);

        const { interaction, applied } = await svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          {},
          { agentId: "agent-a" },
        );

        expect(applied).toBe(true);
        expect(interaction.result).toMatchObject({ outcome: "withdrawn_by_manager" });
      });

      it("never authorizes an actor whose id only appears as a synthesized missing-manager marker", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        // The creator's reportsTo dangles at an id with no row in the company
        // (deleted agent). The chain walk emits an ancestor entry carrying
        // that real id with status "missing" — the status filter is the only
        // thing between that marker and authorization, so it must hold even
        // if an actor authenticates with exactly that id.
        const danglingChainAgents = [
          { id: "agent-1", companyId: "company-1", name: "Creator", status: "active", reportsTo: "agent-ghost" },
        ];
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: danglingChainAgents });
        const svc = issueThreadInteractionService(state.db as never);

        await expect(svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          {},
          { agentId: "agent-ghost" },
        )).rejects.toMatchObject({ status: 403 });
        expect(state.interactionUpdates).toHaveLength(0);
      });

      it("never authorizes a cross-company parent the creator's reportsTo points at", async () => {
        const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
        // Same marker class, resolvable id: the parent row exists but belongs
        // to another company, so the walk must degrade it to a missing marker
        // instead of treating it as a real ancestor. Route-level
        // assertCompanyAccess also blocks this actor; this encodes the
        // service-layer half of that defense in depth.
        const crossCompanyChainAgents = [
          { id: "agent-1", companyId: "company-1", name: "Creator", status: "active", reportsTo: "agent-foreign" },
          { id: "agent-foreign", companyId: "company-2", name: "Foreign", status: "active", reportsTo: null },
        ];
        const state = createFakeDb({ interactionRow: confirmationRow(), parentRows: crossCompanyChainAgents });
        const svc = issueThreadInteractionService(state.db as never);

        await expect(svc.withdrawInteraction(
          ISSUE_REF,
          "interaction-3",
          {},
          { agentId: "agent-foreign" },
        )).rejects.toMatchObject({ status: 403 });
        expect(state.interactionUpdates).toHaveLength(0);
      });
    });
  });
});
