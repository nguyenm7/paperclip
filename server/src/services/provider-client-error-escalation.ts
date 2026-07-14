import { createHash } from "node:crypto";
import {
  ADAPTER_CONFIG_REJECTED_ERROR_CODE,
  PROVIDER_QUOTA_REJECTED_ERROR_FAMILY,
  type ProviderQuotaRejection,
} from "@paperclipai/adapter-utils/server-utils";

export type ProviderClientError = {
  status: number;
  body: string;
};

export type DeterministicRunRejection =
  | { kind: "provider_client_error"; status: number; body: string }
  | { kind: "adapter_config_rejected"; body: string }
  | { kind: "provider_quota_rejected"; body: string; detail: ProviderQuotaRejection };

export const PROVIDER_CLIENT_ERROR_COMMENT_MARKER =
  "<!-- paperclip:provider-client-error -->";

const ESCALATION_SIGNATURE_MARKER_PREFIX = "<!-- paperclip:provider-client-error-signature:";

// One escalation comment per (issue, failure signature) inside this window.
// A retry chain replays the identical failure across several runs; per-run
// dedup would post one comment per run (LOOA-243 burned four runs on one 400).
export const ESCALATION_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1_000;

// 4xx statuses that are retryable for an unchanged request (timeouts, rate
// limits). Escalating them as "expected to fail identically" would be false.
//
// 429 is the subtle one. Most 429s are throttles and belong on the backoff
// ladder, so the *status code* alone can never justify an escalation. But a
// quota/spend-limit 429 is deterministic for the entire window it names, and
// the adapter — the only layer that still sees the rate-limit payload — splits
// those out into the `provider_quota_rejected` error family. Those arrive here
// as a structured `resultJson.providerQuotaRejection`, not as a parsed status
// code, which is why 429 stays excluded below (LOOA-360).
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

type ProviderErrorRun = {
  id: string;
  companyId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  // Optional so adapters/callers that never carry structured failure detail
  // (and the pre-LOOA-360 call shape) stay valid.
  resultJson?: unknown;
  contextSnapshot: unknown;
};

type ProviderErrorAgent = {
  name: string;
  adapterType: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStatus(record: Record<string, unknown>): number | null {
  for (const key of ["status", "statusCode", "status_code"]) {
    const raw = record[key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= 400 &&
      parsed <= 499 &&
      !RETRYABLE_CLIENT_STATUSES.has(parsed)
    ) {
      return parsed;
    }
  }
  return null;
}

function findStructuredClientError(value: unknown, body: string, depth = 0): ProviderClientError | null {
  if (depth > 6) return null;
  const record = asRecord(value);
  if (!record) return null;

  const status = readStatus(record);
  if (status != null) return { status, body };

  for (const nested of Object.values(record)) {
    const found = findStructuredClientError(nested, body, depth + 1);
    if (found) return found;
  }
  return null;
}

export function extractProviderClientError(error: string | null | undefined): ProviderClientError | null {
  const body = error?.trim();
  if (!body) return null;

  try {
    const parsed = JSON.parse(body) as unknown;
    const structured = findStructuredClientError(parsed, body);
    if (structured) return structured;
  } catch {
    // Some adapters return a human-readable HTTP error rather than JSON.
  }

  const statusMatch = body.match(/\b(?:HTTP(?:\s+status)?|status(?:\s+code)?|response)\D{0,20}(4\d\d)\b/i);
  if (!statusMatch) return null;
  const status = Number(statusMatch[1]);
  if (RETRYABLE_CLIENT_STATUSES.has(status)) return null;
  return { status, body };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Canonical, stable rendering of the quota rejection. This doubles as the
 * signature input, so it must contain exactly the fields that define "the same
 * block": the model and the window (plus the reason that produced it). One
 * escalation per (model, window) per issue per 24h — not one per retry.
 *
 * Two agents blocked by the same org-level quota on the same model *are* the
 * same fact, so collapsing them onto one comment is correct, not a miss.
 */
function buildQuotaRejectionBody(detail: ProviderQuotaRejection): string {
  return (
    [
      ["model", detail.model],
      ["resetsAt", detail.resetsAt],
      ["reason", detail.reason],
      ["overageStatus", detail.overageStatus],
      ["rateLimitType", detail.rateLimitType],
    ] as const
  )
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function extractProviderQuotaRejection(
  run: Pick<ProviderErrorRun, "resultJson">,
): DeterministicRunRejection | null {
  const resultJson = asRecord(run.resultJson);
  if (!resultJson) return null;
  if (readOptionalString(resultJson.errorFamily) !== PROVIDER_QUOTA_REJECTED_ERROR_FAMILY) {
    return null;
  }
  const raw = asRecord(resultJson.providerQuotaRejection);
  if (!raw) return null;

  const status = typeof raw.status === "number" && Number.isInteger(raw.status) ? raw.status : null;
  const detail: ProviderQuotaRejection = {
    model: readOptionalString(raw.model),
    resetsAt: readOptionalString(raw.resetsAt),
    reason: readOptionalString(raw.reason),
    overageStatus: readOptionalString(raw.overageStatus),
    rateLimitType: readOptionalString(raw.rateLimitType),
    status,
    message: readOptionalString(raw.message),
  };

  const body = buildQuotaRejectionBody(detail);
  if (!body) return null;
  return { kind: "provider_quota_rejected", body, detail };
}

export function extractDeterministicRunRejection(
  run: Pick<ProviderErrorRun, "errorCode" | "error" | "resultJson">,
): DeterministicRunRejection | null {
  // Checked first: a quota rejection is identified by its structured payload,
  // not by an error code or a parsed status, and its 429 would otherwise be
  // discarded as retryable below.
  const quotaRejection = extractProviderQuotaRejection(run);
  if (quotaRejection) return quotaRejection;

  if (run.errorCode === ADAPTER_CONFIG_REJECTED_ERROR_CODE) {
    const body = run.error?.trim();
    return body ? { kind: "adapter_config_rejected", body } : null;
  }
  if (run.errorCode !== "adapter_failed") return null;
  const providerError = extractProviderClientError(run.error);
  return providerError ? { kind: "provider_client_error", ...providerError } : null;
}

export function escalationSignatureMarker(rejection: DeterministicRunRejection): string {
  const status = rejection.kind === "provider_client_error" ? String(rejection.status) : "";
  const digest = createHash("sha256")
    .update(`${rejection.kind}\n${status}\n${rejection.body}`)
    .digest("hex")
    .slice(0, 16);
  return `${ESCALATION_SIGNATURE_MARKER_PREFIX}${digest} -->`;
}

function indentCodeBlock(value: string) {
  return value
    .slice(0, 4_000)
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

export function buildRunRejectionComment(input: {
  agentName: string;
  adapterType: string;
  runId: string;
  rejection: DeterministicRunRejection;
}) {
  const footer = [PROVIDER_CLIENT_ERROR_COMMENT_MARKER, escalationSignatureMarker(input.rejection)];
  if (input.rejection.kind === "provider_quota_rejected") {
    const { detail } = input.rejection;
    const window = detail.resetsAt
      ? `\`${detail.resetsAt}\``
      : "an unspecified time (the provider reported no reset)";
    const limitDetail = [
      detail.reason ? `reason: \`${detail.reason}\`` : null,
      detail.overageStatus ? `overage status: \`${detail.overageStatus}\`` : null,
      detail.rateLimitType ? `limit: \`${detail.rateLimitType}\`` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return [
      "## Provider quota exhausted — automatic retries stopped",
      "",
      `The provider rejected ${input.agentName}'s run at the quota level and named the window it is blocked for. That window is longer than Paperclip is willing to keep a retry queued: a queued retry holds this issue's execution lock until it runs, so parking one until the reset would freeze the issue for the whole window. Paperclip released the lock and stopped here instead of waiting.`,
      "",
      `- Adapter: \`${input.adapterType}\``,
      ...(detail.model ? [`- Model: \`${detail.model}\``] : []),
      `- Latest run: \`${input.runId}\``,
      `- Blocked until: ${window}`,
      ...(limitDetail ? [`- Provider detail: ${limitDetail}`] : []),
      ...(detail.status ? [`- Provider status: \`${detail.status}\``] : []),
      `- Next action: either wake this agent again at or after ${window}, when the provider says the quota reopens, or move it to a model with available quota (or raise the spend limit) to resume now. Paperclip will not retry on its own before then.`,
      ...(detail.message
        ? ["", "Provider response:", "", indentCodeBlock(detail.message)]
        : []),
      "",
      ...footer,
    ].join("\n");
  }
  if (input.rejection.kind === "adapter_config_rejected") {
    return [
      "## Adapter configuration rejected",
      "",
      `Paperclip refused to start ${input.agentName}'s run: the effective adapter configuration cannot succeed as-is.`,
      "",
      `- Adapter: \`${input.adapterType}\``,
      `- Latest run: \`${input.runId}\``,
      "- Next action: fix the configuration named below before waking this agent again; an unchanged configuration is expected to fail identically.",
      "",
      "Rejection detail:",
      "",
      indentCodeBlock(input.rejection.body),
      "",
      ...footer,
    ].join("\n");
  }
  return [
    "## Provider request rejected",
    "",
    `The provider rejected ${input.agentName}'s request before the heartbeat could complete.`,
    "",
    `- Adapter: \`${input.adapterType}\``,
    `- Latest run: \`${input.runId}\``,
    `- Provider status: \`${input.rejection.status}\``,
    "- Next action: correct the request or adapter configuration before waking this agent again; an unchanged request is expected to fail identically.",
    "",
    "Provider response:",
    "",
    indentCodeBlock(input.rejection.body),
    "",
    ...footer,
  ].join("\n");
}

export async function surfaceProviderClientError(
  input: {
    run: ProviderErrorRun;
    agent: ProviderErrorAgent;
    nowMs?: number;
  },
  dependencies: {
    findRecentEscalation: (
      companyId: string,
      issueId: string,
      signatureMarker: string,
      since: Date,
    ) => Promise<unknown>;
    addSystemIssueComment: (issueId: string, body: string, runId: string) => Promise<unknown>;
  },
): Promise<"not_applicable" | "already_surfaced" | "surfaced"> {
  const context = asRecord(input.run.contextSnapshot);
  const issueId = typeof context?.issueId === "string" ? context.issueId.trim() : "";
  if (!issueId || input.run.status !== "failed") return "not_applicable";
  const rejection = extractDeterministicRunRejection(input.run);
  if (!rejection) return "not_applicable";

  const signatureMarker = escalationSignatureMarker(rejection);
  const since = new Date((input.nowMs ?? Date.now()) - ESCALATION_DEDUP_WINDOW_MS);
  const existing = await dependencies.findRecentEscalation(
    input.run.companyId,
    issueId,
    signatureMarker,
    since,
  );
  if (existing) return "already_surfaced";

  await dependencies.addSystemIssueComment(
    issueId,
    buildRunRejectionComment({
      agentName: input.agent.name,
      adapterType: input.agent.adapterType,
      runId: input.run.id,
      rejection,
    }),
    input.run.id,
  );
  return "surfaced";
}
