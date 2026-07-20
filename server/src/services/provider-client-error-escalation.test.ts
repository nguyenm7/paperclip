import { describe, expect, it, vi } from "vitest";
import {
  buildRunRejectionComment,
  escalationSignatureMarker,
  extractDeterministicRunRejection,
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

const configRejection =
  'Invalid Codex reasoning effort "ultra" from config.toml (model_reasoning_effort) for model "gpt-5.5" ' +
  "from adapterConfig.model. Supported values from models_cache.json: low, medium, high, xhigh. " +
  "Update the offending setting before retrying; Paperclip did not start Codex.";

function makeRun(overrides: Partial<{
  id: string;
  companyId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  resultJson: unknown;
  contextSnapshot: unknown;
}> = {}) {
  return {
    id: "run-3",
    companyId: "company-1",
    status: "failed",
    errorCode: "adapter_failed",
    error: provider400,
    contextSnapshot: { issueId: "issue-1" },
    ...overrides,
  };
}

// LOOA-360: what the claude-local adapter persists for an org-disabled 429.
const quotaDetail = {
  model: "claude-fable-5",
  resetsAt: "2026-07-19T08:00:00.000Z",
  reason: "org_level_disabled_until",
  overageStatus: "rejected",
  rateLimitType: "seven_day_overage_included",
  status: 429,
  message: "You've hit your monthly spend limit.",
};

function makeQuotaRun(overrides: Parameters<typeof makeRun>[0] = {}) {
  return makeRun({
    errorCode: "claude_quota_rejected",
    error: "You've hit your monthly spend limit.",
    resultJson: {
      errorFamily: "provider_quota_rejected",
      providerQuotaRejection: quotaDetail,
    },
    ...overrides,
  });
}

const agent = { name: "Forge", adapterType: "codex_local" };

describe("provider client-error escalation", () => {
  it("extracts structured provider 4xx responses", () => {
    expect(extractProviderClientError(provider400)).toEqual({ status: 400, body: provider400 });
  });

  it("extracts human-readable provider status errors", () => {
    const body = "unexpected status 400 Bad Request: Invalid reasoning.effort";
    expect(extractProviderClientError(body)).toEqual({ status: 400, body });
    expect(extractProviderClientError("HTTP 503 upstream unavailable")).toBeNull();
  });

  it("does not treat retryable 4xx statuses as deterministic", () => {
    expect(extractProviderClientError(JSON.stringify({ status: 429, error: "rate limited" }))).toBeNull();
    expect(extractProviderClientError("HTTP status 429 Too Many Requests")).toBeNull();
    expect(extractProviderClientError("HTTP status 408 Request Timeout")).toBeNull();
    expect(extractProviderClientError("HTTP status 425 Too Early")).toBeNull();
  });

  it("classifies adapter_config_rejected runs as deterministic rejections", () => {
    expect(
      extractDeterministicRunRejection({ errorCode: "adapter_config_rejected", error: configRejection }),
    ).toEqual({ kind: "adapter_config_rejected", body: configRejection });
    expect(
      extractDeterministicRunRejection({ errorCode: "claude_transient_upstream", error: provider400 }),
    ).toBeNull();
  });

  it("renders the provider response and concrete next action", () => {
    const body = buildRunRejectionComment({
      agentName: "Forge",
      adapterType: "codex_local",
      runId: "run-3",
      rejection: { kind: "provider_client_error", status: 400, body: provider400 },
    });
    expect(body).toContain("## Provider request rejected");
    expect(body).toContain("reasoning.effort");
    expect(body).toContain("correct the request or adapter configuration");
    expect(body).toContain(PROVIDER_CLIENT_ERROR_COMMENT_MARKER);
    expect(body).toContain("provider-client-error-signature:");
  });

  it("renders adapter configuration rejections with the offending source", () => {
    const body = buildRunRejectionComment({
      agentName: "Forge",
      adapterType: "codex_local",
      runId: "run-3",
      rejection: { kind: "adapter_config_rejected", body: configRejection },
    });
    expect(body).toContain("## Adapter configuration rejected");
    expect(body).toContain("config.toml (model_reasoning_effort)");
    expect(body).toContain("fix the configuration named below");
    expect(body).toContain(PROVIDER_CLIENT_ERROR_COMMENT_MARKER);
  });

  it("posts a run-attributed system comment for an issue-bound adapter failure", async () => {
    const findRecentEscalation = vi.fn().mockResolvedValue(null);
    const addSystemIssueComment = vi.fn().mockResolvedValue({ id: "comment-1" });

    await expect(
      surfaceProviderClientError(
        { run: makeRun(), agent, nowMs: Date.parse("2026-07-14T12:00:00.000Z") },
        { findRecentEscalation, addSystemIssueComment },
      ),
    ).resolves.toBe("surfaced");

    expect(findRecentEscalation).toHaveBeenCalledWith(
      "company-1",
      "issue-1",
      escalationSignatureMarker({ kind: "provider_client_error", status: 400, body: provider400 }),
      new Date(Date.parse("2026-07-13T12:00:00.000Z")),
    );
    expect(addSystemIssueComment).toHaveBeenCalledOnce();
    expect(addSystemIssueComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Invalid value: 'max'."),
      "run-3",
    );
  });

  it("surfaces adapter preflight config rejections on the wake-source issue", async () => {
    const addSystemIssueComment = vi.fn().mockResolvedValue({ id: "comment-2" });

    await expect(
      surfaceProviderClientError(
        {
          run: makeRun({ errorCode: "adapter_config_rejected", error: configRejection }),
          agent,
        },
        { findRecentEscalation: vi.fn().mockResolvedValue(null), addSystemIssueComment },
      ),
    ).resolves.toBe("surfaced");

    expect(addSystemIssueComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("## Adapter configuration rejected"),
      "run-3",
    );
  });

  it("suppresses duplicate escalations for the same failure signature across retry runs", async () => {
    const addSystemIssueComment = vi.fn();
    await expect(
      surfaceProviderClientError(
        { run: makeRun({ id: "run-4" }), agent },
        {
          findRecentEscalation: vi.fn().mockResolvedValue({ id: "comment-1" }),
          addSystemIssueComment,
        },
      ),
    ).resolves.toBe("already_surfaced");
    expect(addSystemIssueComment).not.toHaveBeenCalled();
  });

  it("uses distinct signatures for distinct failures", () => {
    const providerMarker = escalationSignatureMarker({
      kind: "provider_client_error",
      status: 400,
      body: provider400,
    });
    const configMarker = escalationSignatureMarker({
      kind: "adapter_config_rejected",
      body: configRejection,
    });
    expect(providerMarker).not.toBe(configMarker);
    expect(providerMarker).toMatch(/^<!-- paperclip:provider-client-error-signature:[0-9a-f]{16} -->$/);
  });

  it("ignores runs without an issue, a failed status, or a deterministic rejection", async () => {
    const deps = {
      findRecentEscalation: vi.fn(),
      addSystemIssueComment: vi.fn(),
    };
    await expect(
      surfaceProviderClientError({ run: makeRun({ contextSnapshot: {} }), agent }, deps),
    ).resolves.toBe("not_applicable");
    await expect(
      surfaceProviderClientError({ run: makeRun({ status: "succeeded" }), agent }, deps),
    ).resolves.toBe("not_applicable");
    await expect(
      surfaceProviderClientError(
        { run: makeRun({ errorCode: "claude_transient_upstream" }), agent },
        deps,
      ),
    ).resolves.toBe("not_applicable");
    expect(deps.addSystemIssueComment).not.toHaveBeenCalled();
  });

  describe("org-disabled quota 429 (LOOA-360)", () => {
    it("classifies a quota-rejected run as deterministic even though 429 is a retryable status", () => {
      // The status code alone still proves nothing — it is the structured
      // payload that makes this deterministic.
      expect(extractProviderClientError('HTTP status 429 Too Many Requests')).toBeNull();
      expect(extractDeterministicRunRejection(makeQuotaRun())).toEqual({
        kind: "provider_quota_rejected",
        body: [
          "model=claude-fable-5",
          "resetsAt=2026-07-19T08:00:00.000Z",
          "reason=org_level_disabled_until",
          "overageStatus=rejected",
          "rateLimitType=seven_day_overage_included",
        ].join("\n"),
        detail: quotaDetail,
      });
    });

    it("ignores a transient 429 that carries no quota payload", () => {
      expect(
        extractDeterministicRunRejection(
          makeRun({
            errorCode: "claude_transient_upstream",
            error: "You've hit a rate limit.",
            resultJson: { errorFamily: "transient_upstream", retryNotBefore: "2026-07-14T15:00:00.000Z" },
          }),
        ),
      ).toBeNull();
    });

    it("posts exactly one escalation naming the model and the reset time", async () => {
      const addSystemIssueComment = vi.fn().mockResolvedValue({ id: "comment-3" });

      await expect(
        surfaceProviderClientError(
          { run: makeQuotaRun(), agent: { name: "CTO", adapterType: "claude_local" } },
          { findRecentEscalation: vi.fn().mockResolvedValue(null), addSystemIssueComment },
        ),
      ).resolves.toBe("surfaced");

      expect(addSystemIssueComment).toHaveBeenCalledOnce();
      const body = String(addSystemIssueComment.mock.calls[0]?.[1] ?? "");
      expect(body).toContain("## Provider quota exhausted — automatic retries stopped");
      expect(body).toContain("claude-fable-5");
      expect(body).toContain("2026-07-19T08:00:00.000Z");
      expect(body).toContain("org_level_disabled_until");
      // The reason we stopped, stated as policy: we refuse to hold the issue lock
      // for the window. An operator reading this must be able to act on it.
      expect(body).toContain("holds this issue's execution lock");
      expect(body).toContain("wake this agent again at or after");
    });

    // LOOA-379 review: the escalation is the operator-facing contract, and an
    // earlier revision claimed the block "lasts longer than Paperclip's retry
    // ladder" and that "every retry inside this window fails". That proof was
    // retracted (LOOA-367) — retry wall time has no upper bound, so nothing can
    // establish it. We stop because we will not park the issue lock that long.
    // Pin the retraction: this fails if the unprovable claim returns to the wire.
    it("never claims the block outlasts the retry ladder or that every retry is futile", async () => {
      const addSystemIssueComment = vi.fn().mockResolvedValue({ id: "comment-4" });
      await surfaceProviderClientError(
        { run: makeQuotaRun(), agent: { name: "CTO", adapterType: "claude_local" } },
        { findRecentEscalation: vi.fn().mockResolvedValue(null), addSystemIssueComment },
      );

      const body = String(addSystemIssueComment.mock.calls[0]?.[1] ?? "").toLowerCase();
      for (const forbidden of [
        "retry ladder",
        "every retry",
        "outlasts",
        "guaranteed to fail",
        "bounded retry window",
      ]) {
        expect(body).not.toContain(forbidden);
      }
    });

    it("dedups across retry runs by (model, window) rather than per run", async () => {
      const addSystemIssueComment = vi.fn();
      await expect(
        surfaceProviderClientError(
          { run: makeQuotaRun({ id: "run-9" }), agent },
          {
            findRecentEscalation: vi.fn().mockResolvedValue({ id: "comment-3" }),
            addSystemIssueComment,
          },
        ),
      ).resolves.toBe("already_surfaced");
      expect(addSystemIssueComment).not.toHaveBeenCalled();

      // A different window is a different fact and must escalate again.
      const first = escalationSignatureMarker(extractDeterministicRunRejection(makeQuotaRun())!);
      const nextWindow = escalationSignatureMarker(
        extractDeterministicRunRejection(
          makeQuotaRun({
            resultJson: {
              errorFamily: "provider_quota_rejected",
              providerQuotaRejection: { ...quotaDetail, resetsAt: "2026-08-19T08:00:00.000Z" },
            },
          }),
        )!,
      );
      expect(first).not.toBe(nextWindow);
      expect(first).toMatch(/^<!-- paperclip:provider-client-error-signature:[0-9a-f]{16} -->$/);
    });
  });
});
