export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

export type RecoveryModelProfileWorkClass = "status_only" | "normal_model";

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
  statusOnlyRunGuidance:
    "This is a cheap status-only recovery run: document, plan, and deliverable-artifact writes are rejected with 403. " +
    "Hitting that 403 automatically schedules a one-shot normal-model wake (reason `recovery_deliverable_write_escalation`) " +
    "that is permitted to perform the write — report status honestly and exit instead of retrying the write here.",
} as const;

const RECOVERY_MODEL_PROFILE_HINT_KEYS = [
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
  "statusOnlyRunGuidance",
] as const;

type RecoveryModelProfileHintKey = (typeof RECOVERY_MODEL_PROFILE_HINT_KEYS)[number];
type WithoutRecoveryModelProfileHints<T> = Omit<T, RecoveryModelProfileHintKey>;

export function scrubRecoveryModelProfileHints<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryModelProfileHints<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_MODEL_PROFILE_HINT_KEYS) {
    delete output[key];
  }
  return output as WithoutRecoveryModelProfileHints<T>;
}

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryModelProfileHints<T>;
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
  modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
};
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: RecoveryModelProfileWorkClass,
):
  | WithoutRecoveryModelProfileHints<T>
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  }) {
  if (workClass === "normal_model") {
    return scrubRecoveryModelProfileHints(input);
  }

  return {
    ...scrubRecoveryModelProfileHints(input),
    ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

export function recoveryAssigneeAdapterOverrides(_workClass: Extract<RecoveryModelProfileWorkClass, "status_only">) {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}
