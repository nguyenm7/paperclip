import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findServingService, resolveInstanceRoot, resolveLiveTree } from "./live-service.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeRegistry(records) {
  const home = mkdtempSync(path.join(os.tmpdir(), "pc-live-service-"));
  const env = { PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "default" };
  const registryDir = path.join(resolveInstanceRoot(env), "runtime-services");
  mkdirSync(registryDir, { recursive: true });
  for (const [name, record] of Object.entries(records)) {
    writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(record));
  }
  return env;
}

/**
 * The whole point of this module is that it can be trusted from a git hook,
 * where the TS resolver is not importable -- so it re-derives the instance root
 * by hand. This test is what stops that copy from drifting: it drives the real
 * resolver and demands the same answer.
 */
function findTsxCli() {
  // pnpm does not hoist tsx to the root; the repo's own scripts reach into
  // cli/node_modules for it.
  const candidates = [
    path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "server", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

test("resolveInstanceRoot agrees with the shared TypeScript resolver", (t) => {
  const tsxCli = findTsxCli();

  // A checkout with no `pnpm install` cannot load the TS resolver at all. Skip
  // loudly rather than assert nothing: the drift this test exists to catch is
  // real, so a silent pass would be worse than no test.
  if (!tsxCli) {
    t.skip("tsx is not installed in this checkout -- run `pnpm install` to run the parity check");
    return;
  }

  const probe = path.join(mkdtempSync(path.join(os.tmpdir(), "pc-parity-")), "probe.ts");
  writeFileSync(
    probe,
    `import { resolvePaperclipInstanceRoot } from ${JSON.stringify(
      path.join(repoRoot, "packages", "shared", "src", "home-paths.ts"),
    )};\nprocess.stdout.write(resolvePaperclipInstanceRoot());\n`,
  );

  const env = { ...process.env, PAPERCLIP_HOME: "/tmp/pc-parity-home", PAPERCLIP_INSTANCE_ID: "someinstance" };
  const fromShared = execFileSync("node", [tsxCli, probe], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  assert.equal(fromShared, "/tmp/pc-parity-home/instances/someinstance");
  assert.equal(resolveInstanceRoot(env), fromShared);
});

test("defaults to ~/.paperclip/instances/default", () => {
  assert.equal(
    resolveInstanceRoot({}),
    path.join(os.homedir(), ".paperclip", "instances", "default"),
  );
});

test("returns null when no server has ever registered", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pc-live-service-empty-"));
  assert.equal(findServingService({ PAPERCLIP_HOME: home }), null);
});

test("reports the cwd of the process that is actually serving", () => {
  const env = makeRegistry({
    live: {
      profileKind: "paperclip-dev",
      serviceKey: "live",
      cwd: "/Users/annica/paperclip-live",
      pid: process.pid, // alive by construction
      port: 3100,
      url: "http://127.0.0.1:3100",
      startedAt: "2026-07-14T12:00:00.000Z",
    },
  });

  assert.equal(findServingService(env).cwd, "/Users/annica/paperclip-live");
});

test("ignores a stale record whose process is gone", () => {
  // A server that died without deregistering must not keep claiming to be prod:
  // that is how a guard ends up protecting a tree nothing is serving from.
  const env = makeRegistry({
    dead: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/Paperclip",
      pid: 2 ** 30, // no such process
      startedAt: "2026-07-14T12:00:00.000Z",
    },
  });

  assert.equal(findServingService(env), null);
});

test("ignores services that are not the control plane", () => {
  const env = makeRegistry({
    web: {
      profileKind: "workspace-runtime",
      cwd: "/tmp/some-preview-server",
      pid: process.pid,
      startedAt: "2026-07-14T12:00:00.000Z",
    },
  });

  assert.equal(findServingService(env), null);
});

test("when two servers are registered, the newest owns the port", () => {
  const env = makeRegistry({
    old: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/Paperclip",
      pid: process.pid,
      startedAt: "2026-06-18T04:30:29.469Z",
    },
    new: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/paperclip-live",
      pid: process.pid,
      startedAt: "2026-07-14T13:00:00.000Z",
    },
  });

  assert.equal(findServingService(env).cwd, "/Users/annica/paperclip-live");
});

test("a torn registry file does not take the guard down with it", () => {
  const env = makeRegistry({
    good: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/paperclip-live",
      pid: process.pid,
      startedAt: "2026-07-14T13:00:00.000Z",
    },
  });
  const registryDir = path.join(resolveInstanceRoot(env), "runtime-services");
  writeFileSync(path.join(registryDir, "torn.json"), "{ not json");

  assert.equal(findServingService(env).cwd, "/Users/annica/paperclip-live");
});

test("falls back to the main worktree when nothing is serving", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pc-live-service-down-"));
  const resolved = resolveLiveTree(repoRoot, { PAPERCLIP_HOME: home });

  assert.equal(resolved.source, "main-worktree-fallback");
  assert.equal(resolved.service, null);
  // Conservative: with the server down we still name a tree rather than none.
  assert.ok(resolved.tree.length > 0);
});
