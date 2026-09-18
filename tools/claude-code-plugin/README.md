# Paperclip plugin for Claude Code (v0)

Keeps a Claude Code session aware of the Paperclip issue it is working on, so
you stop asking whether the task is ready to review. **v0 is read-only**: it
watches and reports, it never mutates the issue (see "Why no checkout" below).

| Component | File | What it does |
|---|---|---|
| Monitor | `monitors/monitors.json` → `scripts/pc-watch.sh` | The single poller. Writes `state.json` on transition; its stdout lines reach Claude as notifications. |
| `SessionStart` hook | `scripts/session-start.sh` | Resolves the issue, writes `binding.json` + `config.json`, seeds state, injects the first status line. |
| `UserPromptSubmit` hook | `scripts/task-line.sh` | ~20 tokens of fresh status before Claude reads your prompt. |
| `FileChanged` hook | `scripts/task-line.sh --on-change` | Pushes a transition into the session the moment the watcher writes it. |
| `SessionEnd` hook | `scripts/session-end.sh` | Clears the binding. Nothing else. |
| `pc` | `bin/pc` | The CLI as a bare command, connection flags resolved. |
| JSON helper | `scripts/json.mjs` | `pick` / `fields` / `obj`. Node only — no jq, no npm install. |
| Skill | `skills/paperclip-task/SKILL.md` | How to read state and write results back. |

State lives in `${CLAUDE_PROJECT_DIR}/.paperclip/` (already in this repo's
`.gitignore`; add it to any other repo you test in).

**Issue binding**, resolved once at `SessionStart`:
`PAPERCLIP_TASK_ID` env var → an identifier in the git branch name → an
identifier in the directory name (pattern `ABC-123`, matching the server's
`/^[A-Z][A-Z0-9]*-\d+$/`). No match means no binding and every component
silently no-ops. A binding that never produces a readable issue (e.g. a branch
like `feature-lovelace-71` false-matching `LOVELACE-71`) is abandoned by the
watcher after 5 failed fetches.

## Requirements

Bash and Node (already required to run Paperclip), plus the Paperclip CLI on
PATH — or `PAPERCLIP_CLI="pnpm --dir /path/to/paperclip paperclipai"` to use
this checkout. No jq, no lockfile, no dependency install.

Hooks and monitors execute the scripts directly, so the executable bit matters
(git tracks it, so this is one-time):

```bash
chmod +x bin/pc scripts/*.sh scripts/json.mjs test/smoke.sh
```

## Secrets

`config.json` holds no secrets. The agent API key is read from an environment
variable and config records only the variable's *name* (`api_key_env`, default
`PAPERCLIP_API_KEY`) — the same convention Paperclip context profiles use. The
name is validated as a plain identifier before use, so a hostile `config.json`
in a cloned repo cannot inject shell. This indirection is also why the monitor
works: monitor processes do not receive `CLAUDE_PLUGIN_OPTION_*` values, so
they read the config file the `SessionStart` hook wrote and inherit the key
from the session environment.

## Smoke test (no server, ~30 seconds)

```bash
cd tools/claude-code-plugin
./test/smoke.sh        # -v to see script output
```

Covers binding, transitions, rendering, failure handling, the give-up rule for
false bindings, and proves the API key value never lands on disk.

## Testing against your local company, in a worktree

This walkthrough assumes a local Paperclip server already running (default
`http://localhost:3100`) with your company set up. Run the `pnpm paperclipai`
commands from this repo checkout.

**1. Find the company and mint an agent key:**

```bash
pnpm paperclipai company list --json          # note your company's id
pnpm paperclipai agent local-cli <agent-shortname> --company-id <company-id>
# eval the export lines it prints:
#   PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_AGENT_ID, PAPERCLIP_API_KEY
```

**2. Create a test issue and note its identifier** (e.g. `LOOP-12`):

```bash
pnpm paperclipai issue create --company-id <company-id> \
  --title "claude-code plugin watcher test" --status todo --json
```

**3. Make an isolated worktree whose branch carries the identifier** — the
same `{{issue.identifier}}-{{slug}}` shape Paperclip's execution workspaces
use, so binding resolves exactly as it would in a managed workspace. From
whatever repo the issue is about (this one works fine):

```bash
git worktree add ../LOOP-12-plugin-test -b LOOP-12-plugin-test
cd ../LOOP-12-plugin-test
```

**4. Start Claude Code with the plugin**, with the step-1 env still exported:

```bash
export PAPERCLIP_CLI="pnpm --dir /path/to/paperclip paperclipai"   # dev CLI
claude --plugin-dir /path/to/paperclip/tools/claude-code-plugin
```

On session start you should see a context line like
`Paperclip task LOOP-12: status todo.` — that's the `SessionStart` hook.
Ask "what task am I on?" — Claude should answer from context with **no Bash
call**. If it shells out, the `UserPromptSubmit` hook isn't firing.

**5. Flip status from a second shell** and watch the session react without
being asked:

```bash
pnpm paperclipai issue update <issue-id> --status in_progress --json
# then, after the poll interval (default 15s, configurable):
pnpm paperclipai issue update <issue-id> --status in_review --json
```

Expect a notification in the live session: `LOOP-12: in_progress -> in_review
(ready to review)`. Setting `done` or `cancelled` stops the watcher.

**6. The two-second non-interactive check** (hooks only — monitors are skipped
in `-p` mode and need a real interactive session):

```bash
claude -p "is the paperclip task ready to review?" \
  --plugin-dir /path/to/paperclip/tools/claude-code-plugin
```

**Also worth verifying live** (both were unverifiable from docs):
whether the monitor process receives `CLAUDE_PLUGIN_OPTION_*` vars (add
`env | grep CLAUDE_PLUGIN >> /tmp/mon-env` to `pc-watch.sh` temporarily), and
whether the `FileChanged` matcher accepts the relative path
`.paperclip/state.json`. If `FileChanged` doesn't fire, transitions still
arrive via the monitor notification — the hook is a latency optimization.

**Cleanup:**

```bash
git worktree remove ../LOOP-12-plugin-test
```

### Isolated instance instead of your real one

To avoid touching your real `~/.paperclip` data, run a throwaway instance and
point everything at it:

```bash
PAPERCLIP_TELEMETRY_DISABLED=1 ANTHROPIC_API_KEY=... \
  npx paperclipai test-drive --data-dir ./tmp/pc --no-browser
```

Then add `--data-dir ./tmp/pc` to every CLI command above, and set the
`data_dir` plugin option (or `PAPERCLIP_DATA_DIR`) so the watcher targets it.

## Reload semantics

`SKILL.md` edits apply immediately. Hooks need `/reload-plugins`. **Monitors
require a full session restart.** `claude --debug` explains a silently skipped
component. `claude plugin validate ./tools/claude-code-plugin --strict`
catches manifest typos.

## Statusline

The plugin cannot install it: a plugin's `settings.json` supports only the
`agent` and `subagentStatusLine` keys. Add to your own settings, pointing at
this checkout:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/paperclip/tools/claude-code-plugin/scripts/task-line.sh --plain"
  }
}
```

It reads only the state file, so it costs no tokens and never touches the API.

## Why no checkout/release in v0

The earlier prototype had an opt-in `checkout_on_start` and released the lock
on `SessionEnd`. Both are removed, deliberately:

- Agent-authenticated `checkout`/`release` require an agent **run id**
  (`server/src/routes/issues.ts` returns 401 "Agent run id required" without
  one). A human-launched Claude Code session holding a `local-cli` key has no
  run, so the calls can never succeed as designed.
- Server-side `release` unconditionally resets the issue to `todo` and clears
  the assignee. Releasing at `SessionEnd` would knock an `in_review` issue
  back to `todo` the moment you close the terminal — destroying the exact
  state this plugin exists to surface.

If v1 wants real locks, it needs either a server-side interactive-session
path or conditional release (only while still `in_progress`, only by the
checkout run).

## Also not in v0

`PreToolUse` enforcement of budget hard-stops and tree holds, cost write-back,
the MCP App for issue cards, and channels for board comments. The `signals`
object in `state.json` is the seam: add keys to it, and keep `reviewReady` the
only field consumers read.
