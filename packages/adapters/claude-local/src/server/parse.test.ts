import { describe, expect, it } from "vitest";
import {
  BOUNDED_TRANSIENT_RETRY_DELAYS_MS,
  BOUNDED_TRANSIENT_RETRY_JITTER_RATIO,
  BOUNDED_TRANSIENT_RETRY_MAX_ELAPSED_MS,
  PROVIDER_QUOTA_DETERMINISTIC_HORIZON_MS,
} from "@paperclipai/adapter-utils/server-utils";
import {
  extractClaudeQuotaRejection,
  extractClaudeRetryNotBefore,
  isClaudeSafetyRefusalError,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
} from "./parse.js";

// Verbatim shapes from the LOOA-170 incident (runs 0f9dbfa4/2604b568/edce6fcb,
// 2026-07-10): a real-time cyber-safeguard refusal whose stream also carried a
// benign informational rate_limit_event line.
const SAFETY_REFUSAL_RESULT_TEXT =
  "API Error: Opus 4.8 has safety measures that flagged this message for a cybersecurity topic. " +
  "To learn about the Cyber Verification Program and apply for access, visit our help center: " +
  "https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.\n\n" +
  "Request ID: req_011CctNStRSS5Q2de9yRuVis";
const BENIGN_RATE_LIMIT_EVENT_LINE = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1783701000,
    rateLimitType: "five_hour",
    overageStatus: "allowed",
    isUsingOverage: false,
  },
});
const SAFETY_REFUSAL_RESULT_EVENT = {
  type: "result",
  subtype: "success",
  is_error: true,
  stop_reason: "refusal",
  result: SAFETY_REFUSAL_RESULT_TEXT,
};

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });

  it("does not classify model-safety refusals as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: SAFETY_REFUSAL_RESULT_EVENT,
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: `Claude run failed: subtype=success: ${SAFETY_REFUSAL_RESULT_TEXT}`,
      }),
    ).toBe(false);
  });

  it("ignores benign allowed rate_limit_event stream lines (LOOA-170 regression)", () => {
    // The exact incident shape: a deterministic refusal whose stdout also
    // carries the informational rate_limit_event that every healthy stream
    // emits. `rateLimitType` must not read as transient rate-limit signal.
    expect(
      isClaudeTransientUpstreamError({
        parsed: SAFETY_REFUSAL_RESULT_EVENT,
        stdout: [BENIGN_RATE_LIMIT_EVENT_LINE, JSON.stringify(SAFETY_REFUSAL_RESULT_EVENT)].join("\n"),
      }),
    ).toBe(false);
    // Same benign line next to an unrelated deterministic failure.
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
        stdout: BENIGN_RATE_LIMIT_EVENT_LINE,
      }),
    ).toBe(false);
    // A rate_limit_event that reports an actual limit hit still counts.
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude exited with code 1",
        stdout: JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        }),
      }),
    ).toBe(true);
  });
});

describe("isClaudeSafetyRefusalError", () => {
  it("detects the structural stop_reason refusal on the result event", () => {
    expect(
      isClaudeSafetyRefusalError({
        parsed: SAFETY_REFUSAL_RESULT_EVENT,
      }),
    ).toBe(true);
    expect(
      isClaudeSafetyRefusalError({
        parsed: {
          is_error: true,
          stop_details: { type: "refusal", category: "cyber" },
          result: "refused",
        },
      }),
    ).toBe(true);
  });

  it("detects the refusal wording when no structural stop_reason is present", () => {
    expect(
      isClaudeSafetyRefusalError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: SAFETY_REFUSAL_RESULT_TEXT,
        },
      }),
    ).toBe(true);
    expect(
      isClaudeSafetyRefusalError({
        errorMessage:
          "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.",
      }),
    ).toBe(true);
  });

  it("does not flag ordinary failures or transient upstream errors", () => {
    expect(
      isClaudeSafetyRefusalError({
        parsed: { is_error: true, result: "You're out of extra usage. Resets at 4pm (America/Chicago)." },
      }),
    ).toBe(false);
    expect(
      isClaudeSafetyRefusalError({
        errorMessage: "Claude exited with code 1",
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(false);
    // A recovered mid-run refusal fallback in the stream must not taint an
    // unrelated failure when a parsed result is available.
    expect(
      isClaudeSafetyRefusalError({
        parsed: { is_error: true, result: "Timed out waiting for tool output." },
        stdout: JSON.stringify({
          type: "system",
          subtype: "model_refusal_fallback",
          trigger: "refusal",
          original_model: "claude-fable-5",
          fallback_model: "claude-opus-4-8",
        }),
      }),
    ).toBe(false);
  });
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});

// LOOA-360 / LOOA-365 review. The dangerous direction is suppressing a retry
// that would have succeeded: the agent then goes silent instead of recovering.
// So a rejection is only deterministic when a bounded `resetsAt` proves the
// block outlasts EVERY retry we would attempt.
describe("extractClaudeQuotaRejection", () => {
  const NOW = new Date("2026-07-14T16:00:00.000Z");

  function streamWithRateLimit(rateLimitInfo: Record<string, unknown>) {
    return [
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: rateLimitInfo }),
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 429,
        terminal_reason: "api_error",
        result: "You've hit your monthly spend limit.",
      }),
    ].join("\n");
  }

  function epochSecondsFromNow(ms: number) {
    return Math.floor((NOW.getTime() + ms) / 1_000);
  }

  // The horizon is derived from the ladder, not hand-tuned. If someone adds a
  // rung or widens the jitter, this fires instead of silently suppressing
  // retries that could still have fired. The original bug was a hand-picked
  // 3h constant sitting UNDER a 202.5m worst-case ladder.
  it("keeps the deterministic horizon beyond the last possible retry", () => {
    const maxLadderElapsedMs =
      BOUNDED_TRANSIENT_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) *
      (1 + BOUNDED_TRANSIENT_RETRY_JITTER_RATIO);
    expect(BOUNDED_TRANSIENT_RETRY_MAX_ELAPSED_MS).toBe(Math.round(maxLadderElapsedMs));
    expect(PROVIDER_QUOTA_DETERMINISTIC_HORIZON_MS).toBeGreaterThan(maxLadderElapsedMs);
    // A rolling five-hour window can never clear the horizon, so it can never be
    // mistaken for a permanent block.
    expect(PROVIDER_QUOTA_DETERMINISTIC_HORIZON_MS).toBeGreaterThan(5 * 60 * 60 * 1_000);
  });

  it("classifies the org-disabled spend-limit block (resetsAt days out) as deterministic", () => {
    const resetsAt = epochSecondsFromNow(5 * 24 * 60 * 60 * 1_000);
    expect(
      extractClaudeQuotaRejection(
        {
          parsed: {
            is_error: true,
            api_error_status: 429,
            terminal_reason: "api_error",
            result: "You've hit your monthly spend limit.",
          },
          stdout: streamWithRateLimit({
            status: "rejected",
            resetsAt,
            rateLimitType: "seven_day_overage_included",
            overageStatus: "rejected",
            overageDisabledReason: "org_level_disabled_until",
            isUsingOverage: false,
          }),
          model: "claude-fable-5",
        },
        NOW,
      ),
    ).toMatchObject({
      model: "claude-fable-5",
      reason: "org_level_disabled_until",
      resetsAt: new Date(resetsAt * 1_000).toISOString(),
      status: 429,
    });
  });

  it("keeps a rejection whose reset lands inside the jittered retry ladder transient", () => {
    // Rook's repro: 190 minutes out. The old 180m horizon called this permanent,
    // but a max-jitter fourth retry fires at ~202.5m — after the reset.
    expect(
      extractClaudeQuotaRejection(
        {
          stdout: streamWithRateLimit({
            status: "rejected",
            resetsAt: epochSecondsFromNow(190 * 60 * 1_000),
            rateLimitType: "five_hour",
            overageStatus: "rejected",
          }),
          model: "claude-fable-5",
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps an overage-disabled rejection with no reset time transient", () => {
    // Rook's repro: `overageDisabledReason` proves overage is unavailable, NOT
    // that the included rolling quota stays blocked. With no reset time there is
    // no proven horizon, so it must not be treated as permanent.
    expect(
      extractClaudeQuotaRejection(
        {
          stdout: streamWithRateLimit({
            status: "rejected",
            rateLimitType: "five_hour",
            overageStatus: "rejected",
            overageDisabledReason: "user_level_disabled",
          }),
          model: "claude-fable-5",
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores benign and absent rate-limit events", () => {
    expect(
      extractClaudeQuotaRejection(
        {
          stdout: streamWithRateLimit({
            status: "allowed",
            resetsAt: epochSecondsFromNow(5 * 24 * 60 * 60 * 1_000),
            overageStatus: "allowed",
          }),
        },
        NOW,
      ),
    ).toBeNull();
    expect(extractClaudeQuotaRejection({ stdout: "" }, NOW)).toBeNull();
  });
});
