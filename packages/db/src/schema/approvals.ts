import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    // Authentication source of the decision (session, board_key, cloud_tenant,
    // local_implicit_browser, plugin_gateway). NULL = decided before decision
    // authentication existed; provenance unverifiable.
    decidedByActorSource: text("decided_by_actor_source"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Requester-authored retraction (status "withdrawn"). Deliberately
    // separate from decided_by_* — a withdrawal is not a board decision.
    withdrawnByAgentId: uuid("withdrawn_by_agent_id").references(() => agents.id),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    // Stale-gate detector (LOOA-296). premise_exempt_* marks a card that is
    // deliberately pending on a dead source issue (record-keeping) so the
    // detector never alarms on it. stale_premise_alarmed_at is the raise-once
    // stamp: set after a successful alarm, never cleared by the sweep.
    premiseExemptAt: timestamp("premise_exempt_at", { withTimezone: true }),
    premiseExemptReason: text("premise_exempt_reason"),
    premiseExemptByAgentId: uuid("premise_exempt_by_agent_id").references(() => agents.id),
    premiseExemptByUserId: text("premise_exempt_by_user_id"),
    stalePremiseAlarmedAt: timestamp("stale_premise_alarmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
  }),
);
