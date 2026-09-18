#!/usr/bin/env bash
# Self-contained smoke test. No Paperclip server, no network, no Claude Code.
# Stubs the CLI, drives real status transitions, asserts on the output.
#
#   ./test/smoke.sh          run all checks
#   ./test/smoke.sh -v       also echo the scripts' output

set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERBOSE=false
[ "${1:-}" = "-v" ] && VERBOSE=true

PASS=0
FAIL=0

say() { $VERBOSE && printf '      %s\n' "$1"; return 0; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  ok   %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*)
      printf '  ok   %s\n' "$label"
      PASS=$((PASS + 1)) ;;
    *)
      printf '  FAIL %s\n       expected to contain: %s\n       actual: %s\n' "$label" "$needle" "$haystack"
      FAIL=$((FAIL + 1)) ;;
  esac
}

# ---------------------------------------------------------------- environment

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STATUS_FILE="$WORK/status"
STUB="$WORK/fakepc"
PROJECT="$WORK/proj/pap-42-smoke"
mkdir -p "$PROJECT"
echo todo >"$STATUS_FILE"

cat >"$STUB" <<STUBEOF
#!/usr/bin/env bash
s="\$(cat "$STATUS_FILE" 2>/dev/null || echo todo)"
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "get" ]; then
  printf '{"ok":true,"data":{"issue":{"id":"uuid-1","identifier":"PAP-42","status":"%s","title":"smoke"}}}\n' "\$s"
  exit 0
fi
echo '{}'
STUBEOF
chmod +x "$STUB"

export CLAUDE_PROJECT_DIR="$PROJECT"
export PAPERCLIP_CLI="$STUB"
export CLAUDE_PLUGIN_OPTION_POLL_SECONDS=1

# A fake key, so the test can prove it never lands on disk.
SENTINEL_KEY="pc-smoke-sentinel-do-not-persist"
export PAPERCLIP_API_KEY="$SENTINEL_KEY"

STATE="$PROJECT/.paperclip/state.json"

printf '\nPaperclip plugin smoke test\n\n'

# ---------------------------------------------------------------- prereqs

printf 'prerequisites\n'
if command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1; then
  printf '  ok   node on PATH (%s)\n' "$(node --version 2>/dev/null || nodejs --version)"
  PASS=$((PASS + 1))
else
  printf '  FAIL node not found on PATH — the plugin cannot parse JSON without it\n'
  FAIL=$((FAIL + 1))
  printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
  exit 1
fi

for f in scripts/lib.sh scripts/pc-watch.sh scripts/task-line.sh \
         scripts/session-start.sh scripts/session-end.sh scripts/json.mjs bin/pc; do
  if [ -x "$PLUGIN_DIR/$f" ]; then
    printf '  ok   executable: %s\n' "$f"
    PASS=$((PASS + 1))
  else
    printf '  FAIL not executable: %s  (run: chmod +x bin/pc scripts/*.sh scripts/json.mjs)\n' "$f"
    FAIL=$((FAIL + 1))
  fi
done

# ---------------------------------------------------------------- json helper

printf '\njson helper\n'
check "pick, flat response" \
  "PAP-1	abc	in_review" \
  "$(echo '{"id":"abc","identifier":"PAP-1","status":"in_review"}' | "$PLUGIN_DIR/scripts/json.mjs" pick)"

check "pick, enveloped response" \
  "PAP-9	x	todo" \
  "$(echo '{"ok":true,"data":{"issue":{"id":"x","identifier":"PAP-9","status":"todo"}}}' | "$PLUGIN_DIR/scripts/json.mjs" pick)"

echo 'not json' | "$PLUGIN_DIR/scripts/json.mjs" pick >/dev/null 2>&1
check "pick, malformed input exits nonzero" "1" "$?"

# ---------------------------------------------------------------- binding

printf '\nsession binding\n'
out="$("$PLUGIN_DIR/scripts/session-start.sh" 2>&1)"
say "$out"
check_contains "SessionStart injects a status line" "PAP-42" "$out"
check "binding resolved from directory name" \
  "PAP-42	directory" \
  "$("$PLUGIN_DIR/scripts/json.mjs" fields "$PROJECT/.paperclip/binding.json" issueRef resolvedFrom)"
check "state seeded at todo" \
  "PAP-42	todo	false" \
  "$("$PLUGIN_DIR/scripts/json.mjs" fields "$STATE" identifier status reviewReady)"

cfg="$PROJECT/.paperclip/config.json"
if grep -q "$SENTINEL_KEY" "$cfg" 2>/dev/null; then
  printf '  FAIL config.json contains the API key value — secrets must stay in the environment\n'
  FAIL=$((FAIL + 1))
elif grep -qE '"api_key"[[:space:]]*:' "$cfg" 2>/dev/null; then
  printf '  FAIL config.json has an api_key field\n'
  FAIL=$((FAIL + 1))
else
  printf '  ok   config.json records the key env var name, not the key\n'
  PASS=$((PASS + 1))
fi
check "api_key_env recorded for the monitor to use" "PAPERCLIP_API_KEY" \
  "$("$PLUGIN_DIR/scripts/json.mjs" fields "$cfg" api_key_env)"

unbound="$WORK/proj/plain-repo"
mkdir -p "$unbound"
CLAUDE_PROJECT_DIR="$unbound" "$PLUGIN_DIR/scripts/session-start.sh" >/dev/null 2>&1
check "no identifier means no state file" "absent" \
  "$([ -f "$unbound/.paperclip/state.json" ] && echo present || echo absent)"

# ---------------------------------------------------------------- transitions

printf '\ntransitions\n'
"$PLUGIN_DIR/scripts/pc-watch.sh" >"$WORK/monitor.out" 2>"$WORK/monitor.err" &
WATCHER=$!
sleep 2
echo in_progress >"$STATUS_FILE"; sleep 2
echo in_review    >"$STATUS_FILE"; sleep 2
echo surprise_new >"$STATUS_FILE"; sleep 2
echo done         >"$STATUS_FILE"; sleep 3

monitor_out="$(cat "$WORK/monitor.out")"
say "$monitor_out"

check_contains "transition line, todo to in_progress" "PAP-42: todo -> in_progress" "$monitor_out"
check_contains "review-ready transition is flagged" "in_progress -> in_review (ready to review)" "$monitor_out"
check_contains "unknown status still reported" "in_review -> surprise_new" "$monitor_out"

lines="$(printf '%s\n' "$monitor_out" | grep -c 'PAP-42')"
check "one line per transition, no chatter" "4" "$lines"

if kill -0 "$WATCHER" 2>/dev/null; then
  printf '  FAIL watcher still running after a terminal status\n'
  FAIL=$((FAIL + 1))
  kill "$WATCHER" 2>/dev/null
else
  printf '  ok   watcher exited on terminal status\n'
  PASS=$((PASS + 1))
fi
wait "$WATCHER" 2>/dev/null

# ---------------------------------------------------------------- rendering

printf '\nrendering\n'
echo in_review >"$STATUS_FILE"
"$PLUGIN_DIR/scripts/pc-watch.sh" --once >/dev/null 2>&1

check "context mode (UserPromptSubmit)" \
  "Paperclip task PAP-42: status in_review (ready to review)." \
  "$("$PLUGIN_DIR/scripts/task-line.sh")"
check "plain mode (statusline)" \
  "PAP-42 in_review ready" \
  "$("$PLUGIN_DIR/scripts/task-line.sh" --plain)"
check_contains "change mode (FileChanged)" "ready for review" \
  "$("$PLUGIN_DIR/scripts/task-line.sh" --on-change)"

printf '%s' '{"identifier":"PAP-7","status":"weird_one","reviewReady":false}' >"$WORK/odd.json"
check "unknown status displays, never review-ready" \
  "PAP-7 weird_one" \
  "$("$PLUGIN_DIR/scripts/task-line.sh" --plain --state "$WORK/odd.json")"

check "missing state file renders nothing" "" \
  "$("$PLUGIN_DIR/scripts/task-line.sh" --plain --state "$WORK/nope.json")"

# ---------------------------------------------------------------- failure mode

printf '\nfailure handling\n'
before="$(cat "$STATE")"
PAPERCLIP_CLI=/bin/false "$PLUGIN_DIR/scripts/pc-watch.sh" --once >/dev/null 2>&1
check "failed fetch exits nonzero" "1" "$?"
check "failed fetch leaves state untouched" "$before" "$(cat "$STATE")"

# A binding that never validates (issue unreadable from the start) must give up
# instead of polling a nonexistent issue forever — this is the false-positive
# case, e.g. a branch named feature-lovelace-71 binding to LOVELACE-71.
badbind="$WORK/proj/pap-99-ghost"
mkdir -p "$badbind"
CLAUDE_PROJECT_DIR="$badbind" PAPERCLIP_CLI=/bin/false \
  "$PLUGIN_DIR/scripts/session-start.sh" >/dev/null 2>&1
CLAUDE_PROJECT_DIR="$badbind" PAPERCLIP_CLI=/bin/false \
  "$PLUGIN_DIR/scripts/pc-watch.sh" >"$WORK/ghost.out" 2>"$WORK/ghost.err" &
GHOST=$!
waited=0
while kill -0 "$GHOST" 2>/dev/null && [ "$waited" -lt 30 ]; do
  sleep 1; waited=$((waited + 1))
done
if kill -0 "$GHOST" 2>/dev/null; then
  printf '  FAIL watcher still polling an unreadable issue after %ss\n' "$waited"
  FAIL=$((FAIL + 1)); kill "$GHOST" 2>/dev/null
else
  printf '  ok   watcher gives up on a binding that never validates\n'
  PASS=$((PASS + 1))
fi
wait "$GHOST" 2>/dev/null
check "no notification lines for an unreadable issue" "" "$(cat "$WORK/ghost.out")"
check "unvalidated binding writes no state file" "absent" \
  "$([ -f "$badbind/.paperclip/state.json" ] && echo present || echo absent)"

# config.json lives in the working tree, so a hostile api_key_env value must
# not reach the eval in pc_api_key.
evil="$WORK/evil-config.json"
printf '{ "api_key_env": "PAPERCLIP_API_KEY\\"; touch %s/pwned; echo \\"" }\n' "$WORK" >"$evil"
got="$(bash -c ". '$PLUGIN_DIR/scripts/lib.sh'; PC_CONFIG_FILE='$evil'; pc_api_key" 2>/dev/null)"
check "hostile api_key_env falls back to the default var" "$SENTINEL_KEY" "$got"
check "hostile api_key_env executes nothing" "absent" \
  "$([ -f "$WORK/pwned" ] && echo present || echo absent)"

# ---------------------------------------------------------------- teardown

printf '\nsession end\n'
"$PLUGIN_DIR/scripts/session-end.sh" >/dev/null 2>&1
check "binding cleared" "absent" \
  "$([ -f "$PROJECT/.paperclip/binding.json" ] && echo present || echo absent)"
check "state retained for the statusline" "present" \
  "$([ -f "$STATE" ] && echo present || echo absent)"

# ---------------------------------------------------------------- result

printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
