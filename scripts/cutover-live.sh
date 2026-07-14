#!/usr/bin/env bash
#
# cutover-live.sh -- move the control plane off the development tree. (LOOA-382)
#
# Background: the server runs under `tsx watch` from the same checkout agents
# develop in, so a *save* is a deploy and a *checkout* is a deploy. LOOA-371
# made the bad **commit** impossible; it cannot make the bad **minute**
# impossible, because no git hook can see a save. The only way to remove that
# failure mode rather than police it is to serve from a tree no agent enters.
#
# Two things make this more than "restart a node process", and both are why this
# script exists instead of a wiki page:
#
#   1. The embedded Postgres postmaster is a CHILD of the server process, and
#      its binary is resolved from the serving tree's node_modules. Cutting over
#      restarts the company database, and does so from a different install.
#
#   2. Agent runs are children of the server too -- including the agent running
#      this script. Stopping the server decapitates its own operator. So this
#      script re-execs itself into a new session and finishes the job (including
#      rollback) with no live supervisor.
#
# Usage:
#   scripts/cutover-live.sh --dry-run              # preconditions only, no changes
#   scripts/cutover-live.sh                        # do it (detaches, logs, self-heals)
#   scripts/cutover-live.sh --serving-tree <path>
#
# On failure at any point after the server is stopped, it restores the previous
# tree and health-gates that too. The worst outcome it will accept is "we are
# back where we started"; it never exits leaving nothing serving.

set -uo pipefail

SERVING_TREE="${SERVING_TREE:-/Users/annica/paperclip-live}"
DRY_RUN=0
HEALTH_TIMEOUT_SECS=180
STOP_TIMEOUT_SECS=60

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --serving-tree) SERVING_TREE="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/.paperclip/instances/${PAPERCLIP_INSTANCE_ID:-default}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/cutover-live.log"
RESULT_FILE="${LOG_DIR}/cutover-live.result.json"

log() { printf '[cutover %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; }

# ---------------------------------------------------------------------------
# Detach. Stopping the server kills the agent that launched us (agent runs are
# its children), so a cutover supervised by that agent would be killed halfway
# through -- server down, nothing left running to bring it back. Re-exec into a
# new session so the cutover outlives its operator. macOS has no setsid(1);
# perl's POSIX::setsid is the portable way to get one.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ] && [ "${PAPERCLIP_CUTOVER_DETACHED:-0}" != "1" ]; then
  echo "cutover: detaching into its own session; following ${LOG_FILE}"
  echo "cutover: result will be written to ${RESULT_FILE}"
  PAPERCLIP_CUTOVER_DETACHED=1 \
    perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die $!;' \
    -- bash "${BASH_SOURCE[0]}" --serving-tree "$SERVING_TREE" \
    >>"$LOG_FILE" 2>&1 &
  disown 2>/dev/null || true
  exit 0
fi

exec 2>&1

log "=============================================================="
log "cutover starting (dry-run=${DRY_RUN})"
log "serving tree candidate: ${SERVING_TREE}"

# ---------------------------------------------------------------------------
# Locate the tree that is serving right now, from the process, not a constant.
# ---------------------------------------------------------------------------
LIVE_JSON="$(node "${REPO_ROOT}/scripts/live-service.mjs" --json 2>/dev/null)"
OLD_TREE="$(printf '%s' "$LIVE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.service?j.service.cwd:"")})')"
PORT="$(printf '%s' "$LIVE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.service&&j.service.port?j.service.port:3100))})')"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# Start the new server with the same instance resolution the old one had. An
# inherited PAPERCLIP_HOME would silently point it at a different database --
# the one failure the health gate cannot see.
unset PAPERCLIP_HOME

if [ -z "$OLD_TREE" ]; then
  fail "no control plane is registered as serving; refusing to cut over a server that is already down"
  exit 1
fi
log "currently serving from: ${OLD_TREE} (port ${PORT})"

healthy() {
  curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'
}

wait_for_health() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT_SECS ))
  while [ $SECONDS -lt $deadline ]; do
    if healthy; then return 0; fi
    sleep 2
  done
  return 1
}

# Health is NOT proof the company is back.
#
# A server booted against an empty PAPERCLIP_HOME answers /api/health with
# exactly the same body as the live one -- 200, "status":"ok", and (verified,
# 2026-07-14) even "bootstrapStatus":"ready". Health tells you *a* server is up,
# never *whose data* it has.
#
# What does prove it: a server registers itself in the instance root it
# resolved. So a registration for our new tree appearing in the LIVE instance's
# registry is only possible if that server attached to the live instance. Find
# it there and the identity is settled; look for it and find nothing, and the
# server is up but serving somebody else's database.
serving_tree_per_registry() {
  node "${REPO_ROOT}/scripts/live-service.mjs" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.service?j.service.cwd:"")}catch{process.stdout.write("")}})'
}

# ---------------------------------------------------------------------------
# Preconditions. Every one of these is a way the cutover is known to break;
# all are checked BEFORE anything is stopped, so a failure here costs nothing.
# ---------------------------------------------------------------------------
precondition_failures=0
check() {
  if eval "$2"; then
    log "  ok    -- $1"
  else
    log "  FAIL  -- $1"
    precondition_failures=$(( precondition_failures + 1 ))
  fi
}

log "preconditions:"
check "control plane is healthy right now" "healthy"
check "candidate serving tree exists" "[ -d '${SERVING_TREE}' ]"

# A LINKED WORKTREE MUST NOT BE THE SERVING TREE. The dev runner treats a linked
# worktree as an isolated dev instance: it demands .paperclip/.env and points
# PAPERCLIP_HOME at ~/.paperclip-worktrees. Serving from one would silently bring
# up an EMPTY company on port 3100. A plain clone has a real .git directory and
# resolves the default instance, which is the whole reason this is a clone.
check "serving tree is a real clone, not a linked worktree (.git is a directory)" \
  "[ -d '${SERVING_TREE}/.git' ]"
check "serving tree is on master" \
  "[ \"\$(git -C '${SERVING_TREE}' rev-parse --abbrev-ref HEAD)\" = 'master' ]"
check "serving tree is clean" \
  "[ -z \"\$(git -C '${SERVING_TREE}' status --porcelain)\" ]"
check "serving tree is at the same commit as the integration tree's master" \
  "[ \"\$(git -C '${SERVING_TREE}' rev-parse HEAD)\" = \"\$(git -C '${OLD_TREE}' rev-parse master)\" ]"
check "serving tree has node_modules installed" "[ -d '${SERVING_TREE}/node_modules' ]"
check "lockfiles are identical (same dependency graph as what is serving today)" \
  "cmp -s '${SERVING_TREE}/pnpm-lock.yaml' '${OLD_TREE}/pnpm-lock.yaml'"

# The postmaster binary comes from the SERVING tree's node_modules and must be
# able to open a data directory initialised by the old one. A major-version skew
# here does not degrade -- Postgres refuses to start, and the company has no
# database.
PG_DATA_VERSION="$(cat "${HOME}/.paperclip/instances/${PAPERCLIP_INSTANCE_ID:-default}/db/PG_VERSION" 2>/dev/null || echo "?")"
check "serving tree ships embedded-postgres major ${PG_DATA_VERSION} (matches the cluster on disk)" \
  "ls -d '${SERVING_TREE}'/node_modules/.pnpm/@embedded-postgres+darwin-arm64@${PG_DATA_VERSION}.* >/dev/null 2>&1"

if [ "$precondition_failures" -gt 0 ]; then
  fail "${precondition_failures} precondition(s) failed -- nothing was stopped, the control plane is untouched"
  exit 1
fi
log "all preconditions passed"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: stopping here. Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Back up the database FIRST, while the server that owns it is still up.
# ---------------------------------------------------------------------------
log "backing up the database from the running server..."
if ( cd "$OLD_TREE" && pnpm db:backup >/dev/null 2>&1 ); then
  log "backup ok"
else
  fail "db:backup failed -- refusing to restart the database without a backup"
  exit 1
fi

start_server() {
  local tree="$1"
  log "starting server from ${tree}..."
  ( cd "$tree" && nohup pnpm dev >>"${LOG_DIR}/dev-server.log" 2>&1 & disown 2>/dev/null || true )
}

port_is_free() {
  ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

# Wait for the port to be genuinely FREE, not merely unhealthy.
#
# The server does not fail when its port is taken -- it logs "Requested port is
# busy" and quietly binds the next one. So if we start the new server while the
# old socket is still held, we get a healthy server on 3102 that no client is
# talking to, and a company that thinks it is down. Health going away is not the
# signal; the socket being released is.
stop_server() {
  local tree="$1"
  log "stopping server in ${tree}..."
  ( cd "$tree" && pnpm dev:stop >/dev/null 2>&1 )
  local deadline=$(( SECONDS + STOP_TIMEOUT_SECS ))
  while [ $SECONDS -lt $deadline ]; do
    if port_is_free; then
      # Give the postmaster a moment to checkpoint and release the data dir.
      sleep 3
      port_is_free && return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  log "ROLLING BACK to ${OLD_TREE}"
  stop_server "$SERVING_TREE" || log "warning: the new server did not release ${PORT} cleanly"
  start_server "$OLD_TREE"
  if wait_for_health; then
    log "rollback succeeded -- serving from ${OLD_TREE} again"
    write_result "rolled_back" "$OLD_TREE" "$1"
    exit 1
  fi
  fail "ROLLBACK ALSO FAILED -- the control plane is DOWN and needs a human"
  log "recover with:  cd ${OLD_TREE} && pnpm dev"
  write_result "down" "" "$1"
  exit 2
}

write_result() {
  cat >"$RESULT_FILE" <<EOF
{
  "outcome": "$1",
  "servingTree": "$2",
  "detail": "$3",
  "previousTree": "${OLD_TREE}",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  log "result written to ${RESULT_FILE}"
}

# ---------------------------------------------------------------------------
# The cutover. From here on, something is always being brought back up.
# ---------------------------------------------------------------------------
if ! stop_server "$OLD_TREE"; then
  fail "the old server did not stop within ${STOP_TIMEOUT_SECS}s -- it is still serving; aborting without changes"
  write_result "aborted" "$OLD_TREE" "old server would not stop"
  exit 1
fi
log "old server stopped"

start_server "$SERVING_TREE"

if ! wait_for_health; then
  fail "the new server did not become healthy within ${HEALTH_TIMEOUT_SECS}s"
  rollback "new server failed its health gate"
fi
log "port ${PORT} is healthy"

# Green health only means *a* server is up. This is the check that says it is
# OUR server, attached to the LIVE database.
NOW_SERVING="$(serving_tree_per_registry)"
if [ "$NOW_SERVING" != "$SERVING_TREE" ]; then
  fail "health is green but the live instance's registry says '${NOW_SERVING:-<nothing>}' is serving, not '${SERVING_TREE}'"
  fail "that means the new server came up against a different instance -- it is answering, but not with this company's data"
  rollback "served the wrong instance"
fi
log "registry confirms ${SERVING_TREE} is attached to the live instance"

log "CUTOVER COMPLETE -- the control plane now serves from ${SERVING_TREE}"
log "the development tree ${OLD_TREE} can no longer deploy anything by being edited"
log ""
log "deploys are now:  pnpm deploy:live"
write_result "cutover" "$SERVING_TREE" "healthy and registered"
exit 0
