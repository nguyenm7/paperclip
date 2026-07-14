import fs from "node:fs/promises";
import path from "node:path";
import { AdapterConfigRejectedError, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_MODELS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

type SourcedValue = {
  value: string;
  source: string;
};

type ModelsCacheEntry = {
  slug?: unknown;
  supported_reasoning_levels?: unknown;
};

type ModelsCache = {
  fetched_at?: unknown;
  models?: unknown;
};

type CliOverrides = {
  ignoreUserConfig: boolean;
  profile: string | null;
  model: SourcedValue | null;
  effort: SourcedValue | null;
  provider: SourcedValue | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseTomlBasicString(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end < 0 ? null : trimmed.slice(1, end);
  }
  return null;
}

function readRootTomlString(contents: string, key: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (match?.[1] !== key) continue;
    return parseTomlBasicString(match[2]);
  }
  return null;
}

function readProfileHeaderName(line: string): string | null {
  const match = line.match(/^\[\s*profiles\s*\.\s*(.+?)\s*\]\s*(?:#.*)?$/);
  if (!match) return null;

  const rawName = match[1].trim();
  if (/^[A-Za-z0-9_-]+$/.test(rawName)) return rawName;
  return parseTomlBasicString(rawName);
}

function readProfileTomlString(contents: string, profile: string, key: string): string | null {
  let inSelectedProfile = false;
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inSelectedProfile = readProfileHeaderName(trimmed) === profile;
      continue;
    }
    if (!inSelectedProfile) continue;

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (match?.[1] !== key) continue;
    return parseTomlBasicString(match[2]);
  }
  return null;
}

function readExtraArgs(config: Record<string, unknown>): string[] {
  const extraArgs = asStringArray(config.extraArgs);
  return extraArgs.length > 0 ? extraArgs : asStringArray(config.args);
}

function readConfigOverride(raw: string): { key: string; value: string } | null {
  const separator = raw.indexOf("=");
  if (separator <= 0) return null;
  const key = raw.slice(0, separator).trim();
  const rawValue = raw.slice(separator + 1).trim();
  // Codex treats a value that is not valid TOML as a literal string. Mirror
  // that behavior for the two string settings this preflight resolves.
  const value = parseTomlBasicString(rawValue) ?? rawValue;
  return value == null ? null : { key, value };
}

function readCliOverrides(config: Record<string, unknown>): CliOverrides {
  const resolved: CliOverrides = {
    ignoreUserConfig: false,
    profile: null,
    model: null,
    effort: null,
    provider: null,
  };
  const args = readExtraArgs(config);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ignore-user-config") {
      resolved.ignoreUserConfig = true;
      continue;
    }
    if ((arg === "--profile" || arg === "-p") && args[index + 1]) {
      resolved.profile = args[index + 1].trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      resolved.profile = arg.slice("--profile=".length).trim();
      continue;
    }
    if ((arg === "--model" || arg === "-m") && args[index + 1]) {
      resolved.model = { value: args[index + 1].trim(), source: "adapterConfig.extraArgs (--model)" };
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      resolved.model = { value: arg.slice("--model=".length).trim(), source: "adapterConfig.extraArgs (--model)" };
      continue;
    }
    if ((arg === "--config" || arg === "-c") && args[index + 1]) {
      const override = readConfigOverride(args[index + 1]);
      if (override?.key === "model") {
        resolved.model = { value: override.value, source: "adapterConfig.extraArgs (-c model)" };
      } else if (override?.key === "model_reasoning_effort") {
        resolved.effort = {
          value: override.value,
          source: "adapterConfig.extraArgs (-c model_reasoning_effort)",
        };
      } else if (override?.key === "model_provider") {
        resolved.provider = {
          value: override.value,
          source: "adapterConfig.extraArgs (-c model_provider)",
        };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const override = readConfigOverride(arg.slice("--config=".length));
      if (override?.key === "model") {
        resolved.model = { value: override.value, source: "adapterConfig.extraArgs (--config model)" };
      } else if (override?.key === "model_reasoning_effort") {
        resolved.effort = {
          value: override.value,
          source: "adapterConfig.extraArgs (--config model_reasoning_effort)",
        };
      } else if (override?.key === "model_provider") {
        resolved.provider = {
          value: override.value,
          source: "adapterConfig.extraArgs (--config model_provider)",
        };
      }
    }
  }
  return resolved;
}

async function resolveEffectiveValues(config: unknown, codexHome: string) {
  const record = asRecord(config);
  const configPath = path.join(codexHome, "config.toml");
  const cliOverrides = readCliOverrides(record);
  const configToml = cliOverrides.ignoreUserConfig
    ? null
    : await fs.readFile(configPath, "utf8").catch(() => null);
  const configuredModel = asString(record.model, "").trim();
  const configuredModelReasoningEffort = asString(record.modelReasoningEffort, "").trim();
  const configuredReasoningEffort = asString(record.reasoningEffort, "").trim();

  const configModel = configToml ? readRootTomlString(configToml, "model") : null;
  const configEffort = configToml ? readRootTomlString(configToml, "model_reasoning_effort") : null;
  const configProvider = configToml ? readRootTomlString(configToml, "model_provider") : null;
  const profileModel =
    configToml && cliOverrides.profile
      ? readProfileTomlString(configToml, cliOverrides.profile, "model")
      : null;
  const profileEffort =
    configToml && cliOverrides.profile
      ? readProfileTomlString(configToml, cliOverrides.profile, "model_reasoning_effort")
      : null;
  const profileProvider =
    configToml && cliOverrides.profile
      ? readProfileTomlString(configToml, cliOverrides.profile, "model_provider")
      : null;
  const profileSource =
    cliOverrides.profile ? `${configPath} ([profiles.${JSON.stringify(cliOverrides.profile)}])` : null;

  const resolved: {
    model: SourcedValue | null;
    effort: SourcedValue | null;
    provider: SourcedValue | null;
  } = {
    model: configuredModel
      ? { value: configuredModel, source: "adapterConfig.model" }
      : profileModel && profileSource
        ? { value: profileModel, source: `${profileSource} (model)` }
        : configModel
          ? { value: configModel, source: `${configPath} (model)` }
          : null,
    effort: configuredModelReasoningEffort
      ? { value: configuredModelReasoningEffort, source: "adapterConfig.modelReasoningEffort" }
      : configuredReasoningEffort
        ? { value: configuredReasoningEffort, source: "adapterConfig.reasoningEffort" }
        : profileEffort && profileSource
          ? { value: profileEffort, source: `${profileSource} (model_reasoning_effort)` }
          : configEffort
          ? { value: configEffort, source: `${configPath} (model_reasoning_effort)` }
          : null,
    provider:
      profileProvider && profileSource
        ? { value: profileProvider, source: `${profileSource} (model_provider)` }
        : configProvider
          ? { value: configProvider, source: `${configPath} (model_provider)` }
          : null,
  };

  if (cliOverrides.model) resolved.model = cliOverrides.model;
  if (cliOverrides.effort) resolved.effort = cliOverrides.effort;
  if (cliOverrides.provider) resolved.provider = cliOverrides.provider;
  return resolved;
}

function readSupportedEfforts(entry: ModelsCacheEntry): string[] {
  if (!Array.isArray(entry.supported_reasoning_levels)) return [];
  return entry.supported_reasoning_levels
    .map((level) => asString(asRecord(level).effort, "").trim())
    .filter(Boolean);
}

export async function validateCodexReasoningEffort(input: {
  config: unknown;
  codexHome: string;
  nowMs?: number;
  maxCacheAgeMs?: number;
}): Promise<void> {
  const { model, effort, provider } = await resolveEffectiveValues(input.config, input.codexHome);
  if (!model?.value || !effort?.value) return;
  // models_cache.json describes Codex's built-in OpenAI catalog. A custom
  // provider may intentionally publish the same model slug with a different
  // capability envelope, so the cache is not authoritative for that path.
  if (provider?.value && provider.value !== "openai") return;

  const cachePath = path.join(input.codexHome, "models_cache.json");
  const cache = await fs
    .readFile(cachePath, "utf8")
    .then((contents) => JSON.parse(contents) as ModelsCache)
    .catch(() => null);
  if (!cache || !Array.isArray(cache.models)) return;

  const fetchedAt = typeof cache.fetched_at === "string" ? Date.parse(cache.fetched_at) : Number.NaN;
  const nowMs = input.nowMs ?? Date.now();
  const maxCacheAgeMs = input.maxCacheAgeMs ?? DEFAULT_MODELS_CACHE_MAX_AGE_MS;
  if (!Number.isFinite(fetchedAt) || fetchedAt > nowMs || nowMs - fetchedAt > maxCacheAgeMs) return;

  const entry = cache.models
    .map((candidate) => asRecord(candidate) as ModelsCacheEntry)
    .find((candidate) => candidate.slug === model.value);
  if (!entry) return;

  const supportedEfforts = readSupportedEfforts(entry);
  if (supportedEfforts.length === 0 || supportedEfforts.includes(effort.value)) return;

  throw new AdapterConfigRejectedError(
    `Invalid Codex reasoning effort ${JSON.stringify(effort.value)} from ${effort.source} for model ` +
      `${JSON.stringify(model.value)} from ${model.source}. Supported values from ${cachePath}: ` +
      `${supportedEfforts.join(", ")}. Update the offending setting before retrying; Paperclip did not start Codex.`,
  );
}
