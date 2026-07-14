import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

export const withdrawApprovalSchema = z.object({
  reason: multilineTextSchema.optional().nullable(),
});

export type WithdrawApproval = z.infer<typeof withdrawApprovalSchema>;

// LOOA-296 stale-gate detector: mark a card premise-exempt (deliberately
// pending on a done/cancelled source issue) so the detector never alarms on it.
export const setPremiseExemptSchema = z.object({
  // multilineTextSchema is unbounded; the reason is stored verbatim, so cap it.
  reason: multilineTextSchema
    .pipe(z.string().trim().max(2000))
    .optional()
    .nullable(),
});

export type SetPremiseExempt = z.infer<typeof setPremiseExemptSchema>;
