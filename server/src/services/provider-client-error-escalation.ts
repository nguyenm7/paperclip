import { createHash } from "node:crypto";
import { ADAPTER_CONFIG_REJECTED_ERROR_CODE } from "@paperclipai/adapter-utils/server-utils";

export type ProviderClientError = {
  status: number;
  body: string;
};

export type DeterministicRunRejection =
  | { kind: "provider_client_error"; status: number; body: string }
  | { kind: "adapter_config_rejected"; body: string };

export const PROVIDER_CLIENT_ERROR_COMMENT_MARKER =
  "<!-- paperclip:provider-client-error -->";

const ESCALATION_SIGNATURE_MARKER_PREFIX = "<!-- paperclip:provider-client-error-signature:";

// One escalation comment per (issue, failure signature) inside this window.
// A retry chain replays the identical failure across several runs; per-run
// dedup would post one comment per run (LOOA-243 burned four runs on one 400).
export const ESCALATION_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1_000;

// 4xx statuses that are retryable for an unchanged request (timeouts, rate
// limits). Escalating them as "expected to fail identically" would be false.
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

type ProviderErrorRun = {
  id: string;
  companyId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
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

export function extractDeterministicRunRejection(
  run: Pick<ProviderErrorRun, "errorCode" | "error">,
): DeterministicRunRejection | null {
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
