export type ProviderClientError = {
  status: number;
  body: string;
};

export const PROVIDER_CLIENT_ERROR_COMMENT_MARKER =
  "<!-- paperclip:provider-client-error -->";

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
    if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 499) return parsed;
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
  return { status: Number(statusMatch[1]), body };
}

function indentCodeBlock(value: string) {
  return value
    .slice(0, 4_000)
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

export function buildProviderClientErrorComment(input: {
  agentName: string;
  adapterType: string;
  runId: string;
  providerError: ProviderClientError;
}) {
  return [
    "## Provider request rejected",
    "",
    `The provider rejected ${input.agentName}'s request before the heartbeat could complete.`,
    "",
    `- Adapter: \`${input.adapterType}\``,
    `- Latest run: \`${input.runId}\``,
    `- Provider status: \`${input.providerError.status}\``,
    "- Next action: correct the request or adapter configuration before waking this agent again; an unchanged request is expected to fail identically.",
    "",
    "Provider response:",
    "",
    indentCodeBlock(input.providerError.body),
    "",
    PROVIDER_CLIENT_ERROR_COMMENT_MARKER,
  ].join("\n");
}

export async function surfaceProviderClientError(
  input: {
    run: ProviderErrorRun;
    agent: ProviderErrorAgent;
  },
  dependencies: {
    findExistingEscalation: (runId: string, companyId: string, issueId: string) => Promise<unknown>;
    addSystemIssueComment: (issueId: string, body: string, runId: string) => Promise<unknown>;
  },
): Promise<"not_applicable" | "already_surfaced" | "surfaced"> {
  const context = asRecord(input.run.contextSnapshot);
  const issueId = typeof context?.issueId === "string" ? context.issueId.trim() : "";
  const providerError = extractProviderClientError(input.run.error);
  if (
    !issueId ||
    !providerError ||
    input.run.errorCode !== "adapter_failed" ||
    input.run.status !== "failed"
  ) {
    return "not_applicable";
  }

  const existing = await dependencies.findExistingEscalation(
    input.run.id,
    input.run.companyId,
    issueId,
  );
  if (existing) return "already_surfaced";

  await dependencies.addSystemIssueComment(
    issueId,
    buildProviderClientErrorComment({
      agentName: input.agent.name,
      adapterType: input.agent.adapterType,
      runId: input.run.id,
      providerError,
    }),
    input.run.id,
  );
  return "surfaced";
}
