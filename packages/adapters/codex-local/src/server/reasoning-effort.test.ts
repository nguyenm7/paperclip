import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCodexReasoningEffort } from "./reasoning-effort.js";

const NOW = Date.parse("2026-07-13T16:30:00.000Z");
const homes: string[] = [];

async function makeHome(configToml: string, fetchedAt = "2026-07-13T16:25:00.000Z") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-effort-"));
  homes.push(home);
  await fs.writeFile(path.join(home, "config.toml"), configToml, "utf8");
  await fs.writeFile(
    path.join(home, "models_cache.json"),
    JSON.stringify({
      fetched_at: fetchedAt,
      models: [
        {
          slug: "gpt-5.5",
          supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })),
        },
        {
          slug: "gpt-5.6-sol",
          supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
        },
      ],
    }),
    "utf8",
  );
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("validateCodexReasoningEffort", () => {
  it("fails fast when adapter model and config.toml fall-through effort are incompatible", async () => {
    const home = await makeHome('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n');

    await expect(
      validateCodexReasoningEffort({
        config: { model: "gpt-5.5" },
        codexHome: home,
        nowMs: NOW,
      }),
    ).rejects.toThrow(
      new RegExp(
        `Invalid Codex reasoning effort "ultra" from .*config\\.toml \\(model_reasoning_effort\\) ` +
          `for model "gpt-5\\.5" from adapterConfig\\.model\\. Supported values from .*models_cache\\.json: ` +
          `low, medium, high, xhigh`,
      ),
    );
  });

  it("uses trailing extra-arg overrides when resolving the effective pair", async () => {
    const home = await makeHome('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n');

    await expect(
      validateCodexReasoningEffort({
        config: {
          extraArgs: ["--model", "gpt-5.5", "-c", 'model_reasoning_effort="ultra"'],
        },
        codexHome: home,
        nowMs: NOW,
      }),
    ).rejects.toThrow("adapterConfig.extraArgs (-c model_reasoning_effort)");
  });

  it("mirrors raw long-form Codex config overrides", async () => {
    const home = await makeHome('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n');

    await expect(
      validateCodexReasoningEffort({
        config: {
          extraArgs: ["--config=model=gpt-5.5", "--config=model_reasoning_effort=ultra"],
        },
        codexHome: home,
        nowMs: NOW,
      }),
    ).rejects.toThrow("adapterConfig.extraArgs (--config model_reasoning_effort)");
  });

  it("layers an explicitly selected Codex profile over config.toml", async () => {
    const home = await makeHome(
      [
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "ultra"',
        "",
        "[profiles.forge]",
        'model = "gpt-5.5"',
        "",
      ].join("\n"),
    );

    await expect(
      validateCodexReasoningEffort({
        config: { extraArgs: ["--profile", "forge"] },
        codexHome: home,
        nowMs: NOW,
      }),
    ).rejects.toThrow(/config\.toml \(\[profiles\."forge"\]\) \(model\)/);
  });

  it("reads quoted Codex profile names from config.toml", async () => {
    const home = await makeHome(
      [
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "low"',
        "",
        '[profiles."design.review"]',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "ultra"',
        "",
      ].join("\n"),
    );

    await expect(
      validateCodexReasoningEffort({
        config: { extraArgs: ["--profile=design.review"] },
        codexHome: home,
        nowMs: NOW,
      }),
    ).rejects.toThrow(/\[profiles\."design\.review"\]/);
  });

  it("does not inherit config.toml values with --ignore-user-config", async () => {
    const home = await makeHome('model = "gpt-5.5"\nmodel_reasoning_effort = "ultra"\n');

    await expect(
      validateCodexReasoningEffort({
        config: { extraArgs: ["--ignore-user-config"] },
        codexHome: home,
        nowMs: NOW,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not apply the built-in model cache to a custom provider", async () => {
    const home = await makeHome(
      [
        'model = "gpt-5.5"',
        'model_reasoning_effort = "ultra"',
        'model_provider = "company-gateway"',
        "",
      ].join("\n"),
    );

    await expect(
      validateCodexReasoningEffort({ config: {}, codexHome: home, nowMs: NOW }),
    ).resolves.toBeUndefined();
  });

  it("accepts a supported pair", async () => {
    const home = await makeHome('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n');

    await expect(
      validateCodexReasoningEffort({ config: {}, codexHome: home, nowMs: NOW }),
    ).resolves.toBeUndefined();
  });

  it("skips advisory validation when the cache is stale", async () => {
    const home = await makeHome(
      'model = "gpt-5.5"\nmodel_reasoning_effort = "ultra"\n',
      "2026-07-10T16:25:00.000Z",
    );

    await expect(
      validateCodexReasoningEffort({ config: {}, codexHome: home, nowMs: NOW }),
    ).resolves.toBeUndefined();
  });
});
