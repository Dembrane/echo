#!/usr/bin/env bash
# remote-dev: run the devcontainer stack on a GCP VM, connect to it, and stop
# it again when you are not using it.

set -euo pipefail

RD_COMMANDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/remote-dev/commands"

# The order you actually run them in, not alphabetical.
RD_COMMAND_NAMES="init create up tunnel ssh status sync-code sync-env down start stop resize ssh-config destroy"

usage() {
    cat <<'EOF'
remote-dev: the devcontainer stack on a GCP VM, created, connected to, and stopped again.

Usage:
  ./scripts/remote-dev.sh <command> [options]

Commands:
EOF
    local v desc
    for v in $RD_COMMAND_NAMES; do
        # Each script's second line is its one-line summary. Keeping the help
        # text in the scripts means it cannot drift from what they do.
        desc="$(sed -n '2p' "$RD_COMMANDS_DIR/$v.sh" | sed 's/^# \{0,1\}//')"
        printf '  %-11s %s\n' "$v" "$desc"
    done
    cat <<'EOF'

  ./scripts/remote-dev.sh <command> --help   what that command does, and why

First run:
  ./scripts/remote-dev.sh init && ./scripts/remote-dev.sh create && ./scripts/remote-dev.sh up

Daily:
  ./scripts/remote-dev.sh start    boot the VM, refresh the SSH config
  ./scripts/remote-dev.sh up       bring the containers back
  ./scripts/remote-dev.sh tunnel   forward ports (leave running)
  ./scripts/remote-dev.sh stop     when you finish, to stop paying for compute

Configuration:
  scripts/remote-dev/config.sh   committed defaults, with the reasoning
  scripts/remote-dev/local.env   yours, gitignored, written by init
EOF
}

case "${1:-}" in
    ""|-h|--help|help)
        usage
        exit 0
        ;;
esac

RD_COMMAND="$1"
shift

RD_TARGET="$RD_COMMANDS_DIR/$RD_COMMAND.sh"
if [ ! -f "$RD_TARGET" ]; then
    echo -e "\033[0;31m[remote-dev]\033[0m Unknown command: $RD_COMMAND" >&2
    echo >&2
    usage >&2
    exit 1
fi

exec "$RD_TARGET" "$@"
