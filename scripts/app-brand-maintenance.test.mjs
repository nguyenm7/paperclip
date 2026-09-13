import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyFileBatchAtomically,
  mergeCanonicalBranding,
} from "./app-brand-maintenance.mjs";

test("canonical artwork updates preserve optional branding fields", () => {
  assert.deepEqual(
    mergeCanonicalBranding(
      { logoUrl: "/old.svg", backgroundColor: "#fff", accentColor: "#111" },
      { logoUrl: "/new.svg", darkLogoUrl: "/new-dark.svg" },
    ),
    {
      logoUrl: "/new.svg",
      darkLogoUrl: "/new-dark.svg",
      backgroundColor: "#fff",
      accentColor: "#111",
    },
  );
});

test("failed artwork batches restore every previous destination", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-brand-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.svg");
  const second = path.join(directory, "second.svg");
  fs.writeFileSync(first, "first-old");
  fs.writeFileSync(second, "second-old");

  let stagedRenames = 0;
  const fsApi = {
    ...fs,
    renameSync(from, to) {
      if (from.endsWith(".tmp") && ++stagedRenames === 2) {
        throw new Error("simulated second commit failure");
      }
      return fs.renameSync(from, to);
    },
  };

  assert.throws(
    () => applyFileBatchAtomically(
      [
        { target: first, bytes: Buffer.from("first-new") },
        { target: second, bytes: Buffer.from("second-new") },
      ],
      { fsApi, transactionId: "test" },
    ),
    /previous batch was restored/,
  );
  assert.equal(fs.readFileSync(first, "utf8"), "first-old");
  assert.equal(fs.readFileSync(second, "utf8"), "second-old");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["first.svg", "second.svg"]);
});
