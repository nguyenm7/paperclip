import type { Request } from "express";
import { forbidden } from "../errors.js";
import { assertApprovalDecisionActor } from "./authz.js";

// LOOA-296 stale-gate detector: shared authorization for setting/clearing a
// card's premise-exempt marker on either ledger (board approvals and
// issue-thread interactions). Exempting a card permanently silences a Rule 9
// alarm to the CEO, so the check is decision-grade:
//   - the card's creator agent (Rule 11: the creator stays the card's editor),
//   - the company's CEO-role agent (the alarm's recipient silencing their own
//     alarm), or
//   - an authenticated board identity (same bar as deciding an approval —
//     the unauthenticated localhost route cannot exempt).

export interface PremiseExemptCard {
  companyId: string;
  createdByAgentId: string | null;
}

export interface PremiseExemptActor {
  agentId: string | null;
  userId: string | null;
}

export async function assertPremiseExemptActor(
  req: Request,
  card: PremiseExemptCard,
  getAgentById: (agentId: string) => Promise<{ companyId: string; role: string } | null | undefined>,
): Promise<PremiseExemptActor> {
  if (req.actor.type === "agent") {
    const agentId = req.actor.agentId;
    if (!agentId) throw forbidden("Premise-exempt requires an identified agent actor.");
    if (card.createdByAgentId === agentId) return { agentId, userId: null };
    const agent = await getAgentById(agentId);
    if (agent && agent.companyId === card.companyId && agent.role === "ceo") {
      return { agentId, userId: null };
    }
    throw forbidden(
      "Premise-exempt is limited to the card's creator agent, the company CEO, or an authenticated board identity.",
    );
  }
  assertApprovalDecisionActor(req);
  return { agentId: null, userId: req.actor.userId ?? "board" };
}
