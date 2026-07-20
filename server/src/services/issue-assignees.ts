import { and, eq, inArray, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, companyMemberships } from "@paperclipai/db";
import { normalizeAgentUrlKey, type IssueAssigneeSummary } from "@paperclipai/shared";

type IssueAssignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function assigneeKey(type: IssueAssigneeSummary["type"], id: string) {
  return `${type}:${id}`;
}

export async function listIssueAssigneeSummaries(
  db: Db,
  companyId: string,
  assignments: readonly IssueAssignment[],
): Promise<Map<string, IssueAssigneeSummary>> {
  const agentIds = [
    ...new Set(assignments.flatMap((issue) => issue.assigneeAgentId ? [issue.assigneeAgentId] : [])),
  ];
  const userIds = [
    ...new Set(assignments.flatMap((issue) => issue.assigneeUserId ? [issue.assigneeUserId] : [])),
  ];
  if (agentIds.length === 0 && userIds.length === 0) return new Map();

  const agentRows = db
    .select({
      type: sql<string>`'agent'::text`.as("type"),
      id: sql<string>`${agents.id}::text`.as("id"),
      name: agents.name,
      role: agents.role,
      title: agents.title,
      urlKey: sql<string | null>`null::text`.as("url_key"),
    })
    .from(agents)
    .where(
      agentIds.length > 0
        ? and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))
        : sql`false`,
    );
  const userRows = db
    .select({
      type: sql<string>`'user'::text`.as("type"),
      id: authUsers.id,
      name: authUsers.name,
      role: sql<string>`coalesce(${companyMemberships.membershipRole}, 'user')`.as("role"),
      title: sql<string | null>`null::text`.as("title"),
      urlKey: sql<string | null>`null::text`.as("url_key"),
    })
    .from(authUsers)
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, authUsers.id),
      ),
    )
    .where(userIds.length > 0 ? inArray(authUsers.id, userIds) : sql`false`);

  const rows = await unionAll(agentRows, userRows);
  const summaries = new Map<string, IssueAssigneeSummary>();
  for (const userId of userIds) {
    summaries.set(assigneeKey("user", userId), {
      type: "user",
      id: userId,
      name: userId === "local-board" ? "Board" : "User",
      role: "user",
      title: null,
      urlKey: null,
    });
  }
  for (const row of rows) {
    const type = row.type === "agent" ? "agent" : "user";
    const summary: IssueAssigneeSummary = {
      ...row,
      type,
      urlKey: type === "agent" ? normalizeAgentUrlKey(row.name) ?? row.id : null,
    };
    summaries.set(assigneeKey(type, row.id), summary);
  }
  return summaries;
}

export function issueAssigneeSummary(
  summaries: ReadonlyMap<string, IssueAssigneeSummary>,
  issue: IssueAssignment,
): IssueAssigneeSummary | null {
  if (issue.assigneeAgentId) {
    return summaries.get(assigneeKey("agent", issue.assigneeAgentId)) ?? null;
  }
  if (issue.assigneeUserId) {
    return summaries.get(assigneeKey("user", issue.assigneeUserId)) ?? null;
  }
  return null;
}
