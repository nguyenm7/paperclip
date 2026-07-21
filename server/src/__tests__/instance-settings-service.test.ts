import { describe, expect, it } from "vitest";
import { normalizeExperimentalSettings } from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: false,
      enableConferenceRoomChat: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableCloudSync: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      serverSideDriftSweepMode: "log",
      serverSideDriftAlertAgentId: null,
    });
  });

  it("defaults enableConferenceRoomChat to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableConferenceRoomChat).toBe(false);
    expect(normalizeExperimentalSettings({}).enableConferenceRoomChat).toBe(false);
    // Rows persisted before the flag existed (PAP-137) must normalize to off.
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("round-trips an enableConferenceRoomChat patch through the update merge", () => {
    // updateExperimental merges `{ ...normalize(current), ...patch }` and
    // re-normalizes; emulate that to prove the flag survives the roundtrip
    // without disturbing other settings.
    const current = normalizeExperimentalSettings({});
    const enabled = normalizeExperimentalSettings({ ...current, enableConferenceRoomChat: true });
    expect(enabled.enableConferenceRoomChat).toBe(true);
    expect(enabled.enableStreamlinedLeftNavigation).toBe(false);

    const disabled = normalizeExperimentalSettings({ ...enabled, enableConferenceRoomChat: false });
    expect(disabled).toEqual(current);
  });

  it("rejects non-boolean enableConferenceRoomChat values back to the default", () => {
    expect(
      normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults the server-side drift sweep to log with no alert agent", () => {
    const s = normalizeExperimentalSettings({});
    expect(s.serverSideDriftSweepMode).toBe("log");
    expect(s.serverSideDriftAlertAgentId).toBeNull();
  });

  it("round-trips a create_issue drift config with an alert agent", () => {
    const agentId = "4840b55d-7ed4-4d64-8a56-5961e001a494";
    const s = normalizeExperimentalSettings({
      serverSideDriftSweepMode: "create_issue",
      serverSideDriftAlertAgentId: agentId,
    });
    expect(s.serverSideDriftSweepMode).toBe("create_issue");
    expect(s.serverSideDriftAlertAgentId).toBe(agentId);
  });

  it("falls back to log for an invalid drift mode and rejects a non-uuid alert agent", () => {
    const s = normalizeExperimentalSettings({
      serverSideDriftSweepMode: "deploy_now",
      serverSideDriftAlertAgentId: "not-a-uuid",
    });
    // safeParse fails on the bad enum/uuid, so the whole object normalizes to defaults.
    expect(s.serverSideDriftSweepMode).toBe("log");
    expect(s.serverSideDriftAlertAgentId).toBeNull();
  });
});
