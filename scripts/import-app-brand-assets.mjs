import fs from "node:fs";
import path from "node:path";
import { validateManifest } from "./app-brand-validation.mjs";
import { applyFileBatchAtomically } from "./app-brand-maintenance.mjs";

const args = process.argv.slice(2);
const sourceArg = args.indexOf("--source-dir");
if (sourceArg < 0 || !args[sourceArg + 1]) throw new Error("Usage: node scripts/import-app-brand-assets.mjs --source-dir <extracted-bundle> [--apply]");
const sourceRoot = fs.realpathSync(args[sourceArg + 1]);
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "ui/public/brands/apps/manifest.json"), "utf8"));
const pending = new Map();
// Validate the entire batch before any write. Never download an unreviewed URL.
const count = validateManifest(manifest, (asset, provenance) => {
  const file = fs.realpathSync(path.resolve(sourceRoot, provenance.sourceFile));
  if (!file.startsWith(sourceRoot + path.sep)) throw new Error("Source path escapes the bundle");
  const bytes = fs.readFileSync(file);
  if (pending.has(asset) && !pending.get(asset).equals(bytes)) throw new Error(`Conflicting sources for ${asset}`);
  pending.set(asset, bytes);
  return bytes;
});
let changed = 0;
const changes = [];
for (const [asset, bytes] of pending) {
  const target = path.join(root, "ui/public", asset);
  if (fs.existsSync(target) && fs.readFileSync(target).equals(bytes)) continue;
  changed++;
  changes.push({ target, bytes });
}
if (args.includes("--apply")) applyFileBatchAtomically(changes);
console.log(`${args.includes("--apply") ? "Applied" : "Dry run"}: ${count} identities validated; ${changed} asset files ${args.includes("--apply") ? "updated" : "would change"}.`);
