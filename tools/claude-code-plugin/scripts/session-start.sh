#!/usr/bin/env bash
# SessionStart: figure out which Paperclip issue this session is for, write the
# binding plus a non-secret config file (the monitor reads that, since monitor
# processes do not receive CLAUDE_PLUGIN_OPTION_* env vars), then seed state.json.
#
# Issue resolution: PAPERCLIP_TASK_ID (set when Paperclip launched this run)
# -> an identifier in the git branch name -> an identifier in the directory name.
# No match means no binding, no state file, and every other component no-ops.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

extract_id() {
  printf '%s' "$1" | grep -oE '[A-Za-z][A-Za-z0-9]{1,9}-[0-9]+' | head -n1 | tr '[:lower:]' '[:upper:]'
}

issue_ref=""
resolved_from=""

if [ -n "${PAPERCLIP_TASK_ID:-}" ]; then
  issue_ref="$PAPERCLIP_TASK_ID"
  resolved_from="PAPERCLIP_TASK_ID"
fi

if [ -z "$issue_ref" ] && command -v git >/dev/null 2>&1; then
  # Resolve against the project directory, not the process cwd — a hook can
  # run from anywhere, and the wrong repo's branch must not bind the session.
  branch="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
    issue_ref="$(extract_id "$branch")"
    [ -n "$issue_ref" ] && resolved_from="branch:$branch"
  fi
fi

if [ -z "$issue_ref" ]; then
  issue_ref="$(extract_id "$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")")"
  [ -n "$issue_ref" ] && resolved_from="directory"
fi

if [ -z "$issue_ref" ]; then
  rm -f "$PC_STATE_FILE" "$PC_BINDING_FILE" 2>/dev/null
  exit 0
fi

if ! pc_ready; then
  echo "Paperclip plugin: node not found on PATH; task status unavailable this session." >&2
  exit 0
fi

mkdir -p "$PC_STATE_DIR"

# Non-secret config only. The API key stays in the environment.
pc_json obj \
  "issueRef=$issue_ref" \
  "api_base=$(pc_cfg api_base http://localhost:3100)" \
  "company_id=$(pc_cfg company_id "")" \
  "agent_id=$(pc_cfg agent_id "")" \
  "data_dir=$(pc_cfg data_dir "")" \
  "api_key_env=$(pc_cfg api_key_env PAPERCLIP_API_KEY)" \
  "review_ready_statuses=$(pc_cfg review_ready_statuses in_review)" \
  "terminal_statuses=$(pc_cfg terminal_statuses done,cancelled)" \
  "poll_seconds:=$(pc_cfg poll_seconds 15)" \
  | pc_atomic_write "$PC_CONFIG_FILE"

pc_json obj \
  "issueRef=$issue_ref" \
  "resolvedFrom=$resolved_from" \
  "boundAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | pc_atomic_write "$PC_BINDING_FILE"

# v0 is deliberately read-only: no checkout here. The server requires an agent
# run id for checkout/release (a human-launched session has none), and release
# resets the issue to todo — both wrong for an interactive session.

# Seed state.json so the very first prompt already carries status.
"$SCRIPT_DIR/pc-watch.sh" --once >/dev/null 2>&1 || true

# Stdout from SessionStart becomes session context.
"$SCRIPT_DIR/task-line.sh" || true
