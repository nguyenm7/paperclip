#!/usr/bin/env bash
# Shared helpers for the Paperclip Claude Code plugin.
#
# Config resolution, in order:
#   1. CLAUDE_PLUGIN_OPTION_* env vars   (hooks only — monitors do not receive these)
#   2. PAPERCLIP_* env vars              (what `paperclipai agent local-cli` prints)
#   3. .paperclip/config.json            (written by session-start.sh, read by the monitor)
#
# Secrets are deliberately NOT written to config.json. The API key is read from an
# environment variable, and config.json records only which variable holds it —
# the same convention Paperclip context profiles use.
#
# JSON goes through scripts/json.mjs (Node, already required to run Paperclip),
# so the plugin has no jq or npm dependency.

set -uo pipefail

PC_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PC_STATE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/.paperclip"
PC_STATE_FILE="$PC_STATE_DIR/state.json"
PC_BINDING_FILE="$PC_STATE_DIR/binding.json"
PC_CONFIG_FILE="$PC_STATE_DIR/config.json"

pc_node() {
  if [ -n "${PAPERCLIP_NODE:-}" ]; then printf '%s' "$PAPERCLIP_NODE"; return; fi
  command -v node >/dev/null 2>&1 && { printf 'node'; return; }
  command -v nodejs >/dev/null 2>&1 && { printf 'nodejs'; return; }
  printf ''
}

pc_json() {
  local n; n="$(pc_node)"
  [ -z "$n" ] && return 1
  "$n" "$PC_LIB_DIR/json.mjs" "$@"
}

pc_ready() { [ -n "$(pc_node)" ]; }

# pc_cfg <key> [default]
pc_cfg() {
  local key="$1" default="${2-}" upper val
  upper="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')"

  eval "val=\${CLAUDE_PLUGIN_OPTION_${upper}:-}"
  [ -n "$val" ] && { printf '%s' "$val"; return; }

  eval "val=\${PAPERCLIP_${upper}:-}"
  [ -n "$val" ] && { printf '%s' "$val"; return; }

  if [ -f "$PC_CONFIG_FILE" ]; then
    val="$(pc_json fields "$PC_CONFIG_FILE" "$key" 2>/dev/null)"
    [ -n "$val" ] && { printf '%s' "$val"; return; }
  fi

  printf '%s' "$default"
}

pc_api_key() {
  local var
  if [ -n "${CLAUDE_PLUGIN_OPTION_API_KEY:-}" ]; then
    printf '%s' "$CLAUDE_PLUGIN_OPTION_API_KEY"; return
  fi
  var="$(pc_cfg api_key_env PAPERCLIP_API_KEY)"
  # config.json lives in the working tree, so a cloned repo could ship one.
  # Only a plain variable name may reach the eval below.
  case "$var" in
    ""|[0-9]*|*[!A-Za-z0-9_]*) var=PAPERCLIP_API_KEY ;;
  esac
  eval "printf '%s' \"\${${var}:-}\""
}

# pc_cli [args...] — the Paperclip CLI with resolved connection flags.
# PAPERCLIP_CLI overrides the binary, e.g. PAPERCLIP_CLI="pnpm paperclipai".
pc_cli() {
  local -a cmd flags
  local api_base data_dir key

  if [ -n "${PAPERCLIP_CLI:-}" ]; then
    # shellcheck disable=SC2206
    cmd=(${PAPERCLIP_CLI})
  elif command -v paperclipai >/dev/null 2>&1; then
    cmd=(paperclipai)
  else
    cmd=(npx --yes --registry https://registry.npmjs.org paperclipai)
  fi

  flags=()
  api_base="$(pc_cfg api_base "")"
  [ -n "$api_base" ] && flags+=(--api-base "$api_base")
  data_dir="$(pc_cfg data_dir "")"
  [ -n "$data_dir" ] && flags+=(--data-dir "$data_dir")

  key="$(pc_api_key)"
  if [ -n "$key" ]; then
    PAPERCLIP_API_KEY="$key" "${cmd[@]}" "$@" "${flags[@]}"
  else
    "${cmd[@]}" "$@" "${flags[@]}"
  fi
}

# pc_atomic_write <path> — stdin to path via temp file + mv, so no reader ever
# sees a half-written file.
pc_atomic_write() {
  local target="$1" tmp
  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp "${target}.XXXXXX")" || return 1
  if cat >"$tmp"; then mv -f "$tmp" "$target"; else rm -f "$tmp"; return 1; fi
}

pc_issue_ref() {
  [ -f "$PC_BINDING_FILE" ] || return 1
  pc_json fields "$PC_BINDING_FILE" issueRef 2>/dev/null
}

pc_csv_contains() {
  local needle="$1" csv="$2" item
  local IFS=','
  for item in $csv; do
    item="$(printf '%s' "$item" | tr -d '[:space:]')"
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}
