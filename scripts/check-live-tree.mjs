#!/usr/bin/env node
/**
 * check-live-tree.mjs
 *
 * The repository's *main* worktree is production.
 *
 * The server runs from it under `tsx watch`, so the main worktree's files are
 * the deployed bytes: every save is a deploy, and a half-written file is a
 * half-deployed server. On 2026-07-14 an in-progress feature sitting
 * uncommitted in the main worktree hot-reloaded into the running process and
 * 500'd every issues route company-wide (LOOA-371).
 *
 * The invariant, therefore:
 *
 *   The main worktree is only ever on `master`, and only ever clean.
 *
 * All development happens in a linked worktree (`git worktree add`). `master`
 * only advances by merge. This script is the *detector* for that invariant;
 * `scripts/git-hooks/pre-commit` is the *preventer* (it refuses commits that
 * author new work in the main worktree). Install the hooks with
 * `pnpm hooks:install`.
 *
 * A merge/revert/cherry-pick/rebase in progress is the sanctioned way `master`
 * advances, so it is reported as a transient state rather than a violation --
 * a checker that cries wolf gets switched off.
 *
 * Usage:
 *   node scripts/check-live-tree.mjs          # exit 1 on violation
 *   node scripts/check-live-tree.mjs --json
 *
 * Runnable from any worktree: it always inspects the main one.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Branch the main worktree must be parked on. */
export const LIVE_BRANCH = "master";

/**
 * Git state files that mean "an integration is mid-flight". These are the
 * sanctioned ways master advances, and they legitimately leave the tree dirty
 * and/or on a detached HEAD, so they are not violations.
 */
const INTEGRATION_MARKERS = [
  "MERGE_HEAD",
  "REVERT_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/**
 * Pure predicate: given the observed state of the main worktree, is the
 * invariant intact?
 *
 * @param {{ branch: string, dirtyPaths: string[], integrationInProgress: boolean }} state
 * @returns {{ ok: boolean, transient: boolean, violations: Array<{code: string, detail: string}> }}
 */
export function evaluateLiveTree(state) {
  const { branch, dirtyPaths = [], integrationInProgress = false } = state;

  // A merge in flight is how master is *supposed* to move. Don't alarm on it.
  if (integrationInProgress) {
    return { ok: true, transient: true, violations: [] };
  }

  const violations = [];

  if (branch !== LIVE_BRANCH) {
    violations.push({
      code: "off-master",
      detail:
        `the live tree is on '${branch}', not '${LIVE_BRANCH}' -- the server is ` +
        `serving that branch's code`,
    });
  }

  if (dirtyPaths.length > 0) {
    violations.push({
      code: "dirty",
      detail:
        `${dirtyPaths.length} uncommitted path(s) in the live tree -- ` +
        `every save is hot-reloaded into the running server: ${dirtyPaths
          .slice(0, 10)
          .join(", ")}${dirtyPaths.length > 10 ? ", ..." : ""}`,
    });
  }

  return { ok: violations.length === 0, transient: false, violations };
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * The main worktree is the first entry of `git worktree list --porcelain`.
 * Resolving it this way (rather than hard-coding a path) keeps the check
 * correct on any machine and any clone.
 */
export function findMainWorktree(cwd = process.cwd()) {
  const listing = git(["worktree", "list", "--porcelain"], cwd);
  const first = listing.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) throw new Error("could not resolve the main worktree");
  return first.slice("worktree ".length);
}

export function inspectLiveTree(cwd = process.cwd()) {
  const mainWorktree = findMainWorktree(cwd);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], mainWorktree);

  const integrationInProgress = INTEGRATION_MARKERS.some((marker) =>
    existsSync(path.join(gitDir, marker)),
  );

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], mainWorktree);
  const dirtyPaths = git(["status", "--porcelain"], mainWorktree)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));

  return {
    mainWorktree,
    state: { branch, dirtyPaths, integrationInProgress },
    result: evaluateLiveTree({ branch, dirtyPaths, integrationInProgress }),
  };
}

function main() {
  const asJson = process.argv.includes("--json");
  const { mainWorktree, state, result } = inspectLiveTree();

  if (asJson) {
    console.log(JSON.stringify({ mainWorktree, ...state, ...result }, null, 2));
  } else if (result.transient) {
    console.log(`live tree (${mainWorktree}): integration in progress -- skipping check`);
  } else if (result.ok) {
    console.log(`live tree (${mainWorktree}): clean, on ${LIVE_BRANCH}`);
  } else {
    console.error(`LIVE TREE VIOLATION -- ${mainWorktree} is production.\n`);
    for (const violation of result.violations) {
      console.error(`  [${violation.code}] ${violation.detail}`);
    }
    console.error(
      `\nThe server runs from this tree under \`tsx watch\`, so its working files are\n` +
        `the deployed bytes. Move the work into a linked worktree:\n\n` +
        `  git -C ${mainWorktree} stash                      # or: git switch -c <branch> && git commit\n` +
        `  git worktree add ../paperclip-<ticket> -b <branch>\n\n` +
        `Never discard the work to clear this -- preserve it first, then restore master.`,
    );
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
