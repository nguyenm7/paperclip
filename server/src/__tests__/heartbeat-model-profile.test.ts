import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveEffectiveConfiguredModel,
  resolveModelProfileApplication,
  shouldResetTaskSessionForModelChange,
} from "../services/heartbeat.ts";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "../services/recovery/model-profile-hint.js";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("uses the Codex local adapter cheap default when the agent has no runtime override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {
        model: "gpt-5.3-codex-spark",
        modelReasoningEffort: "high",
      },
    });
  });

  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });
});

describe("model pins vs model profile overlays (LOOA-173)", () => {
  it("keeps a pinned agent model on a status_only recovery wake while still lowering effort", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("claude_local"),
      agentRuntimeConfig: {},
      issueModelProfile: recoveryAssigneeAdapterOverrides("status_only").modelProfile,
      contextSnapshot: withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only"),
    });

    expect(modelProfile).toMatchObject({
      applied: "cheap",
      configSource: "adapter_default",
      modelSource: "adapter_default",
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "claude-fable-5", effort: "high" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(merged.model).toBe("claude-fable-5");
    expect(merged.effort).toBe("low");
  });

  it("still applies the adapter-default cheap model when the agent has no pin", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("claude_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { effort: "high" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(merged.model).toBe("claude-sonnet-4-6");
    expect(merged.effort).toBe("low");
  });

  it("lets an agent-runtime profile model replace the pin as an explicit per-agent opt-in", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: { model: "agent-cheap" },
          },
        },
      },
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({ modelSource: "agent_runtime" });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "pinned-primary" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(merged.model).toBe("agent-cheap");
  });

  it("never lets a blank runtime profile model erase a pin", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: { model: "" },
          },
        },
      },
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    expect(modelProfile).toMatchObject({ modelSource: null });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "pinned-primary" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(merged.model).toBe("pinned-primary");
  });

  it("never lets a blank issue-level model override erase a pin", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "pinned-primary" },
      modelProfile,
      issueAdapterConfig: { model: "  " },
    });

    expect(merged.model).toBe("pinned-primary");
  });

  it("records the effective model in session tracking so real swaps trigger the reset", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("claude_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    // Unpinned agent: the cheap lane is the effective model, and returning to
    // the primary lane resets the session created on the cheap model.
    const cheapLaneModel = resolveEffectiveConfiguredModel({
      baseConfig: {},
      modelProfile,
      issueAdapterConfig: null,
    });
    expect(cheapLaneModel).toBe("claude-sonnet-4-6");
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: "claude-fable-5",
        taskSessionParams: {
          sessionId: "thread-1",
          __paperclipConfiguredModel: cheapLaneModel,
        },
      }),
    ).toBe(true);

    // Pinned agent: both lanes run the pin, so no spurious session reset.
    const pinnedLaneModel = resolveEffectiveConfiguredModel({
      baseConfig: { model: "claude-fable-5" },
      modelProfile,
      issueAdapterConfig: null,
    });
    expect(pinnedLaneModel).toBe("claude-fable-5");
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: pinnedLaneModel,
        taskSessionParams: {
          sessionId: "thread-1",
          __paperclipConfiguredModel: "claude-fable-5",
        },
      }),
    ).toBe(false);
  });
});
