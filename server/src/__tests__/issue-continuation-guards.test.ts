import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  goals,
  instanceSettings,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue continuation guards (wake_assignee must always have someone to wake)", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-continuation-guards-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(args?: { issueStatus?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null }) {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Continuation guard fixture",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GuardAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Guarded issue",
      status: args?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: args?.assigneeAgentId === undefined ? agentId : args.assigneeAgentId,
      assigneeUserId: args?.assigneeUserId ?? null,
    });

    return { companyId, goalId, issueId, agentId };
  }

  function confirmationInput(continuationPolicy: "wake_assignee" | "wake_assignee_on_accept" | "none") {
    return {
      kind: "request_confirmation" as const,
      continuationPolicy,
      payload: {
        version: 1 as const,
        prompt: "Accept this?",
      },
    };
  }

  describe("interaction creation", () => {
    it("refuses wake_assignee interactions on an issue with no assignee at all", async () => {
      const { companyId, issueId } = await seedFixture({ issueStatus: "todo", assigneeAgentId: null });

      await expect(interactionsSvc.create(
        { id: issueId, companyId },
        confirmationInput("wake_assignee"),
        { agentId: randomUUID() },
      )).rejects.toMatchObject({ status: 422 });
    });

    it("refuses wake_assignee_on_accept interactions on an unassigned issue for user actors too", async () => {
      const { companyId, issueId } = await seedFixture({ issueStatus: "todo", assigneeAgentId: null });

      await expect(interactionsSvc.create(
        { id: issueId, companyId },
        confirmationInput("wake_assignee_on_accept"),
        { userId: "local-board" },
      )).rejects.toMatchObject({ status: 422 });
    });

    it("allows wake_assignee interactions when the issue has an assigned agent", async () => {
      const { companyId, issueId } = await seedFixture();

      const created = await interactionsSvc.create(
        { id: issueId, companyId },
        confirmationInput("wake_assignee"),
        { userId: "local-board" },
      );
      expect(created.status).toBe("pending");
    });

    it("allows continuationPolicy none on an unassigned issue", async () => {
      const { companyId, issueId } = await seedFixture({ issueStatus: "todo", assigneeAgentId: null });

      const created = await interactionsSvc.create(
        { id: issueId, companyId },
        confirmationInput("none"),
        { userId: "local-board" },
      );
      expect(created.status).toBe("pending");
    });

    it("allows an agent-created confirmation on a user-assigned issue (acceptance returns to creator)", async () => {
      const { companyId, issueId, agentId } = await seedFixture({
        issueStatus: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
      });

      const created = await interactionsSvc.create(
        { id: issueId, companyId },
        confirmationInput("wake_assignee"),
        { agentId },
      );
      expect(created.status).toBe("pending");
    });

    it("refuses non-confirmation wake_assignee kinds on a user-assigned issue (no return-to-creator path)", async () => {
      const { companyId, issueId, agentId } = await seedFixture({
        issueStatus: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
      });

      await expect(interactionsSvc.create(
        { id: issueId, companyId },
        {
          kind: "suggest_tasks",
          continuationPolicy: "wake_assignee",
          payload: {
            version: 1,
            tasks: [{ clientKey: "a", title: "Follow-up" }],
          },
        },
        { agentId },
      )).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("issue update", () => {
    it("refuses clearing the assignee while a pending wake_assignee interaction exists", async () => {
      const { companyId, issueId } = await seedFixture();
      await interactionsSvc.create({ id: issueId, companyId }, confirmationInput("wake_assignee"), { userId: "local-board" });

      await expect(issuesSvc.update(issueId, {
        assigneeAgentId: null,
        status: "todo",
      })).rejects.toMatchObject({ status: 422 });
    });

    it("allows agent-to-agent reassignment under a pending wake_assignee interaction", async () => {
      const { companyId, issueId } = await seedFixture();
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await interactionsSvc.create({ id: issueId, companyId }, confirmationInput("wake_assignee"), { userId: "local-board" });

      const updated = await issuesSvc.update(issueId, { assigneeAgentId: otherAgentId });
      expect(updated?.assigneeAgentId).toBe(otherAgentId);
    });

    it("allows handing off to a user reviewer when pending confirmations were agent-created", async () => {
      const { companyId, issueId, agentId } = await seedFixture();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "local-board",
        status: "active",
      });
      await interactionsSvc.create({ id: issueId, companyId }, confirmationInput("wake_assignee"), { agentId });

      const updated = await issuesSvc.update(issueId, {
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
      });
      expect(updated?.assigneeUserId).toBe("local-board");
    });

    it("allows clearing the assignee when the issue is being closed", async () => {
      const { companyId, issueId } = await seedFixture();
      await interactionsSvc.create({ id: issueId, companyId }, confirmationInput("wake_assignee"), { userId: "local-board" });

      const updated = await issuesSvc.update(issueId, { status: "done", assigneeAgentId: null });
      expect(updated?.status).toBe("done");
    });

    it("refuses moving an issue to in_review with no assignee at all", async () => {
      const { issueId } = await seedFixture({ issueStatus: "todo", assigneeAgentId: null });

      await expect(issuesSvc.update(issueId, { status: "in_review" }))
        .rejects.toMatchObject({ status: 422 });
    });

    it("still allows unrelated edits on an issue already in a violating state", async () => {
      const { issueId } = await seedFixture({ issueStatus: "in_review", assigneeAgentId: null });

      const updated = await issuesSvc.update(issueId, { title: "Renamed while in_review and unassigned" });
      expect(updated?.title).toBe("Renamed while in_review and unassigned");
    });
  });

  describe("issue create", () => {
    it("refuses creating an in_review issue with no assignee", async () => {
      const { companyId, goalId } = await seedFixture();

      await expect(issuesSvc.create(companyId, {
        title: "Born unreviewable",
        status: "in_review",
        goalId,
      })).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("issue release", () => {
    it("refuses an agent release while a pending wake_assignee interaction exists", async () => {
      const { companyId, issueId, agentId } = await seedFixture();
      await interactionsSvc.create({ id: issueId, companyId }, confirmationInput("wake_assignee"), { userId: "local-board" });

      await expect(issuesSvc.release(issueId, agentId)).rejects.toMatchObject({ status: 409 });
    });

    it("lets a system release proceed (logged loudly) so recovery flows never wedge", async () => {
      const { companyId, issueId } = await seedFixture();
      await interactionsSvc.create({ id: issueId, companyId }, confirmationInput("wake_assignee"), { userId: "local-board" });

      const released = await issuesSvc.release(issueId);
      expect(released?.assigneeAgentId).toBeNull();
      expect(released?.status).toBe("todo");
    });
  });
});
