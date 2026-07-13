import { describe, expect, it, vi } from "vitest";
import {
  buildProviderClientErrorComment,
  extractProviderClientError,
  PROVIDER_CLIENT_ERROR_COMMENT_MARKER,
  surfaceProviderClientError,
} from "./provider-client-error-escalation.js";

const provider400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    code: "invalid_value",
    message: "Invalid value: 'max'.",
    param: "reasoning.effort",
  },
  status: 400,
}, null, 2);

describe("provider client-error escalation", () => {
  it("extracts structured provider 4xx responses", () => {
    expect(extractProviderClientError(provider400)).toEqual({ status: 400, body: provider400 });
  });

  it("extracts human-readable provider status errors", () => {
    const body = "unexpected status 400 Bad Request: Invalid reasoning.effort";
    expect(extractProviderClientError(body)).toEqual({ status: 400, body });
    expect(extractProviderClientError("HTTP 503 upstream unavailable")).toBeNull();
  });

  it("renders the provider response and concrete next action", () => {
    const body = buildProviderClientErrorComment({
      agentName: "Forge",
      adapterType: "codex_local",
      runId: "run-3",
      providerError: { status: 400, body: provider400 },
    });
    expect(body).toContain("## Provider request rejected");
    expect(body).toContain("reasoning.effort");
    expect(body).toContain("correct the request or adapter configuration");
    expect(body).toContain(PROVIDER_CLIENT_ERROR_COMMENT_MARKER);
  });

  it("posts a run-attributed system comment for an issue-bound adapter failure", async () => {
    const findExistingEscalation = vi.fn().mockResolvedValue(null);
    const addSystemIssueComment = vi.fn().mockResolvedValue({ id: "comment-1" });

    await expect(
      surfaceProviderClientError(
        {
          run: {
            id: "run-3",
            companyId: "company-1",
            status: "failed",
            errorCode: "adapter_failed",
            error: provider400,
            contextSnapshot: { issueId: "issue-1" },
          },
          agent: { name: "Forge", adapterType: "codex_local" },
        },
        { findExistingEscalation, addSystemIssueComment },
      ),
    ).resolves.toBe("surfaced");

    expect(addSystemIssueComment).toHaveBeenCalledOnce();
    expect(addSystemIssueComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Invalid value: 'max'."),
      "run-3",
    );
  });

  it("does not duplicate an escalation comment attributed to the same run", async () => {
    const addSystemIssueComment = vi.fn();
    await expect(
      surfaceProviderClientError(
        {
          run: {
            id: "run-3",
            companyId: "company-1",
            status: "failed",
            errorCode: "adapter_failed",
            error: provider400,
            contextSnapshot: { issueId: "issue-1" },
          },
          agent: { name: "Forge", adapterType: "codex_local" },
        },
        {
          findExistingEscalation: vi.fn().mockResolvedValue({ id: "comment-1" }),
          addSystemIssueComment,
        },
      ),
    ).resolves.toBe("already_surfaced");
    expect(addSystemIssueComment).not.toHaveBeenCalled();
  });
});
