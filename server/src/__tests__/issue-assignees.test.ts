import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueAssigneeSummary, listIssueAssigneeSummaries } from "../services/issue-assignees.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue assignee summaries", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let queryLog: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-assignees-");
    db = createDb(tempDb.connectionString);
    (db as any).session.logger = {
      logQuery(query: string) {
        queryLog.push(query);
      },
    };
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
    queryLog = [];
  });

  afterAll(async () => {
    await (db as any)?.$client.end();
    await tempDb?.cleanup();
  });

  it("hydrates a mixed batch with one lookup query regardless of issue count", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Rook Agent",
      role: "engineer",
      title: "Crack Engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Board Reviewer",
      email: "reviewer@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: now,
    });
    queryLog = [];

    const assignments = Array.from({ length: 400 }, (_, index) => ({
      assigneeAgentId: index % 2 === 0 ? agentId : null,
      assigneeUserId: index % 2 === 1 ? userId : null,
    }));
    const summaries = await listIssueAssigneeSummaries(db, companyId, assignments);

    expect(queryLog).toHaveLength(1);
    expect(queryLog[0]).toContain("union all");
    expect(issueAssigneeSummary(summaries, assignments[0]!)).toEqual({
      type: "agent",
      id: agentId,
      name: "Rook Agent",
      role: "engineer",
      title: "Crack Engineer",
      urlKey: "rook-agent",
    });
    expect(issueAssigneeSummary(summaries, assignments[1]!)).toEqual({
      type: "user",
      id: userId,
      name: "Board Reviewer",
      role: "owner",
      title: null,
      urlKey: null,
    });
    expect(
      issueAssigneeSummary(summaries, {
        assigneeAgentId: agentId,
        assigneeUserId: userId,
      })?.type,
    ).toBe("agent");
    expect(
      issueAssigneeSummary(summaries, {
        assigneeAgentId: null,
        assigneeUserId: null,
      }),
    ).toBeNull();
  });
});
