#!/usr/bin/env node
/**
 * live-service.mjs
 *
 * Answers one question: **which working tree is production right now?**
 *
 * Before LOOA-382 the answer was a property of the repository layout -- the
 * main worktree, because that is where `pnpm dev` had always been run from.
 * That made it tempting to hard-code, and LOOA-371 correctly resisted that by
 * deriving it structurally (`--git-dir == --git-common-dir`).
 *
 * But the layout was never the real source of truth. Production is wherever the
 * serving process actually has its cwd. LOOA-382 moves the server into a
 * dedicated checkout, at which point "main worktree" and "production" are
 * different directories -- and any guard still equating the two would be
 * protecting the wrong tree while the real one runs unguarded.
 *
 * So ask the process, not the directory. The dev runner already registers the
 * serving process in the local service registry, recording its cwd and port.
 * That record is the honest answer, and it stays correct across the cutover
 * without anyone remembering to update a constant.
 *
 * Falls back to the main worktree when nothing is registered (server down), so
 * the guards keep a conservative answer rather than no answer.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * The dev runner registers the serving process under this profile.
 * Source of truth: scripts/dev-service-profile.ts (`profileKind`).
 */
const DEV_SERVICE_PROFILE_KIND = "paperclip-dev";

/** Mirrors packages/shared/src/home-paths.ts. Kept dependency-free on purpose: */
/** this module is imported from a git hook, where TS/workspace resolution is  */
/** not available. `scripts/live-service.test.mjs` pins it against the real     */
/** resolver so the duplication cannot silently drift.                          */
export function resolveInstanceRoot(env = process.env) {
  const home = env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return path.resolve(expandHome(home), "instances", instanceId);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * The serving checkout, as reported by the process that is actually serving.
 *
 * @returns {{ cwd: string, pid: number, port: number|null, url: string|null, serviceKey: string } | null}
 */
export function findServingService(env = process.env) {
  const registryDir = path.join(resolveInstanceRoot(env), "runtime-services");

  let entries;
  try {
    entries = readdirSync(registryDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null; // No registry yet -- nothing has ever served from this instance.
  }

  const candidates = [];
  for (const entry of entries) {
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(registryDir, entry), "utf8"));
    } catch {
      continue; // A torn or hand-edited record is not a reason to fail the guard.
    }

    if (record?.profileKind !== DEV_SERVICE_PROFILE_KIND) continue;
    if (typeof record.cwd !== "string" || !record.cwd) continue;
    if (!isProcessAlive(record.pid)) continue; // Stale record from a dead server.

    candidates.push({
      cwd: record.cwd,
      pid: record.pid,
      port: typeof record.port === "number" ? record.port : null,
      url: typeof record.url === "string" ? record.url : null,
      serviceKey: record.serviceKey ?? entry,
      startedAt: record.startedAt ?? "",
    });
  }

  if (candidates.length === 0) return null;

  // If two servers are somehow up, the most recently started one owns the port.
  candidates.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return candidates[0];
}

/** The main worktree of the repo containing `cwd`. The conservative fallback. */
export function findMainWorktree(cwd = process.cwd()) {
  const listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const first = listing.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) throw new Error("could not resolve the main worktree");
  return first.slice("worktree ".length);
}

/**
 * The tree whose files are the deployed bytes.
 *
 * `source` says how we know, because the two answers mean different things: a
 * registry hit is the tree a live process is serving; the fallback is only a
 * guess at the tree a process *would* serve.
 *
 * @returns {{ tree: string, source: "service-registry"|"main-worktree-fallback", service: object|null }}
 */
export function resolveLiveTree(cwd = process.cwd(), env = process.env) {
  const service = findServingService(env);
  if (service) {
    return { tree: service.cwd, source: "service-registry", service };
  }
  return { tree: findMainWorktree(cwd), source: "main-worktree-fallback", service: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const resolved = resolveLiveTree();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(resolved, null, 2));
  } else {
    console.log(`live tree: ${resolved.tree}  (via ${resolved.source})`);
    if (resolved.service) {
      console.log(`  served by pid ${resolved.service.pid} on ${resolved.service.url ?? "?"}`);
    }
  }
}
