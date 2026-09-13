import fs from "node:fs";
import path from "node:path";

export function mergeCanonicalBranding(existing, canonical) {
  return { ...(existing ?? {}), ...canonical };
}

export function applyFileBatchAtomically(changes, options = {}) {
  const fsApi = options.fsApi ?? fs;
  const transactionId = options.transactionId ?? `${process.pid}-${Date.now()}`;
  const prepared = changes.map(({ target, bytes }) => ({
    target,
    bytes,
    staged: `${target}.paperclip-${transactionId}.tmp`,
    backup: `${target}.paperclip-${transactionId}.bak`,
    existed: fsApi.existsSync(target),
    committed: false,
  }));

  try {
    // Stage the complete batch before changing any destination.
    for (const entry of prepared) {
      fsApi.mkdirSync(path.dirname(entry.target), { recursive: true });
      fsApi.writeFileSync(entry.staged, entry.bytes, { flag: "wx" });
    }

    for (const entry of prepared) {
      if (entry.existed) fsApi.renameSync(entry.target, entry.backup);
      try {
        fsApi.renameSync(entry.staged, entry.target);
        entry.committed = true;
      } catch (error) {
        if (entry.existed && fsApi.existsSync(entry.backup)) {
          fsApi.renameSync(entry.backup, entry.target);
        }
        throw error;
      }
    }

    for (const entry of prepared) {
      if (entry.existed && fsApi.existsSync(entry.backup)) fsApi.unlinkSync(entry.backup);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...prepared].reverse()) {
      try {
        if (entry.committed && fsApi.existsSync(entry.target)) fsApi.unlinkSync(entry.target);
        if (entry.existed && fsApi.existsSync(entry.backup)) fsApi.renameSync(entry.backup, entry.target);
        if (fsApi.existsSync(entry.staged)) fsApi.unlinkSync(entry.staged);
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.target}: ${rollbackError.message}`);
      }
    }
    const suffix = rollbackErrors.length ? ` Rollback errors: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`Connector artwork import failed; the previous batch was restored.${suffix}`, { cause: error });
  }
}
