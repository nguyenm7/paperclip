#!/usr/bin/env bash
# One-line status, rendered from the state file. Three callers:
#   UserPromptSubmit hook  -> stdout becomes context for the turn
#   FileChanged hook       -> same, on a real transition (--on-change)
#   statusline             -> --plain, for the user's own settings.json
#
# Reads only the state file, so it returns fast and never touches the API.

set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE=context
while [ $# -gt 0 ]; do
  case "$1" in
    --on-change) MODE=change ;;
    --plain) MODE=plain ;;
    --state) PC_STATE_FILE="${2:-}"; shift ;;
  esac
  shift
done

[ -f "$PC_STATE_FILE" ] || exit 0
pc_ready || exit 0

row="$(pc_json fields "$PC_STATE_FILE" identifier status reviewReady previousStatus 2>/dev/null || true)"
[ -n "$row" ] || exit 0
IFS=$'\t' read -r identifier status review_ready previous <<<"$row"
[ -n "$identifier" ] || exit 0
[ -n "$status" ] || status="unknown"

case "$MODE" in
  plain)
    if [ "$review_ready" = "true" ]; then
      printf '%s %s ready\n' "$identifier" "$status"
    else
      printf '%s %s\n' "$identifier" "$status"
    fi
    ;;
  change)
    if [ -n "$previous" ]; then
      printf 'Paperclip %s moved from %s to %s.' "$identifier" "$previous" "$status"
    else
      printf 'Paperclip %s is %s.' "$identifier" "$status"
    fi
    [ "$review_ready" = "true" ] && printf ' It is ready for review.'
    printf '\n'
    ;;
  *)
    printf 'Paperclip task %s: status %s' "$identifier" "$status"
    [ "$review_ready" = "true" ] && printf ' (ready to review)'
    printf '.\n'
    ;;
esac
