#!/usr/bin/env bash
# The one poller. Everything else (statusline, UserPromptSubmit hook, FileChanged
# hook) reads the state file this writes.
#
#   pc-watch.sh            long-lived; prints a line to stdout on each transition
#                          (as a plugin monitor, those lines reach Claude as notifications)
#   pc-watch.sh --once     single fetch, write state, print nothing
#   pc-watch.sh --issue X  override the bound issue (for standalone testing)
#   pc-watch.sh --out P    write state elsewhere (for standalone testing)
#
# Writes only when status actually changes, so the statusline never flickers and
# the FileChanged hook fires once per real transition.

set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ONCE=false
ISSUE_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=true ;;
    --issue) ISSUE_OVERRIDE="${2:-}"; shift ;;
    --out) PC_STATE_FILE="${2:-}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "pc-watch: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

pc_ready || { echo "pc-watch: node is required and was not found on PATH" >&2; exit 1; }

# The monitor can start before the SessionStart hook has written the binding.
issue_ref="$ISSUE_OVERRIDE"
if [ -z "$issue_ref" ]; then
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    issue_ref="$(pc_issue_ref || true)"
    [ -n "$issue_ref" ] && break
    $ONCE && break
    attempt=$((attempt + 1))
    sleep 1
  done
fi
[ -z "$issue_ref" ] && exit 0

POLL="$(pc_cfg poll_seconds 15)"
# Config values come from a file in the working tree; keep arithmetic safe.
case "$POLL" in ''|*[!0-9]*) POLL=15 ;; esac
[ "$POLL" -lt 1 ] && POLL=1
REVIEW_READY="$(pc_cfg review_ready_statuses in_review)"
TERMINAL="$(pc_cfg terminal_statuses done,cancelled)"

prev_status=""
if [ -f "$PC_STATE_FILE" ]; then
  prev_status="$(pc_json fields "$PC_STATE_FILE" status 2>/dev/null || true)"
fi

first_pass=true
backoff=1
validated=false
consecutive_failures=0

while :; do
  row="$(pc_cli issue get "$issue_ref" --json 2>/dev/null | pc_json pick 2>/dev/null)"

  if [ -z "$row" ]; then
    # Never overwrite good state with a failed fetch.
    $ONCE && { echo "pc-watch: could not read issue $issue_ref" >&2; exit 1; }
    consecutive_failures=$((consecutive_failures + 1))
    # A binding that has never produced a readable issue is probably a false
    # positive from the branch/directory regex — give up quietly instead of
    # polling a nonexistent issue forever.
    if ! $validated && [ "$consecutive_failures" -ge 5 ]; then
      echo "pc-watch: issue $issue_ref not readable after $consecutive_failures attempts; stopping (wrong binding, server down, or missing key)" >&2
      exit 0
    fi
    if [ "$consecutive_failures" -ge 60 ]; then
      echo "pc-watch: issue $issue_ref unreadable for $consecutive_failures polls; stopping" >&2
      exit 0
    fi
    sleep $((POLL * backoff))
    [ "$backoff" -lt 4 ] && backoff=$((backoff + 1))
    continue
  fi
  backoff=1
  validated=true
  consecutive_failures=0

  IFS=$'\t' read -r identifier issue_id status <<<"$row"
  [ -n "$identifier" ] || identifier="$issue_ref"
  [ -n "$status" ] || status="unknown"

  review_ready=false
  pc_csv_contains "$status" "$REVIEW_READY" && review_ready=true
  is_terminal=false
  pc_csv_contains "$status" "$TERMINAL" && is_terminal=true

  if [ "$status" != "$prev_status" ]; then
    # Build signals through json.mjs so a server-supplied status can't break
    # the JSON (or smuggle extra fields into it).
    signals="$(pc_json obj "status=$status")"
    pc_json obj \
      "identifier=$identifier" \
      "issueId=$issue_id" \
      "status=$status" \
      "previousStatus=$prev_status" \
      "changedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "reviewReady:=$review_ready" \
      "terminal:=$is_terminal" \
      "signals:=$signals" \
      | pc_atomic_write "$PC_STATE_FILE"

    if ! $ONCE; then
      # Quiet on the first observation unless it is already actionable;
      # a notification at every session start is noise.
      if ! $first_pass; then
        if $review_ready; then
          printf '%s: %s -> %s (ready to review)\n' "$identifier" "${prev_status:-unknown}" "$status"
        else
          printf '%s: %s -> %s\n' "$identifier" "${prev_status:-unknown}" "$status"
        fi
      elif $review_ready; then
        printf '%s is %s (ready to review)\n' "$identifier" "$status"
      fi
    fi

    prev_status="$status"
  fi

  first_pass=false
  $ONCE && exit 0
  $is_terminal && exit 0
  sleep "$POLL"
done
