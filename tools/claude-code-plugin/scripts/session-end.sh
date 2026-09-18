#!/usr/bin/env bash
# SessionEnd: drop the binding so a later session in the same directory
# re-resolves. State is kept so the statusline still renders after the session.
#
# Deliberately no `issue release` here. The server's release resets the issue
# to todo and clears the assignee whatever its current status, and rejects
# agent-key calls that carry no run id — so releasing from an interactive
# session is both impossible and, if it worked, destructive (it would knock an
# in_review issue back to todo the moment you close the terminal).

set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

rm -f "$PC_BINDING_FILE" 2>/dev/null
exit 0
