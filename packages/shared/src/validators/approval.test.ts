import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APPROVAL_TYPES } from "../constants.js";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  // LOOA-396 F4 (defense in depth): issueIds is the stale-gate alarm amplifier —
  // one approval linking every done/cancelled issue fans into one CEO prompt.
  // The detector is self-bounding, but this schema cap kills the bulk-create
  // vector at the source. 100 is far above any legitimate linkage.
  it("caps issueIds at 100 to bound the stale-gate alarm amplifier (LOOA-396 F4)", () => {
    const base = { type: APPROVAL_TYPES[0], payload: {} };
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    expect(() => createApprovalSchema.parse({ ...base, issueIds: ids(100) })).not.toThrow();
    expect(() => createApprovalSchema.parse({ ...base, issueIds: ids(101) })).toThrow();
  });

  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });
});
