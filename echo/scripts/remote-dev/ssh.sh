#!/usr/bin/env bash
# Opens a shell.
#
#   ./ssh.sh               shell inside the devcontainer, in /workspaces/echo
#   ./ssh.sh --vm          shell on the VM itself (docker, logs, disk)
#   ./ssh.sh <command...>  run a command in the devcontainer and exit
#
# The devcontainer shell is a login shell, which matters: fnm, node, pnpm and
# uv are put on PATH by ~/.bashrc, so a non-login shell cannot find them.

RD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$RD_SCRIPT_DIR/lib.sh"

require_gcloud
require_running

if [ "${1:-}" = "--vm" ]; then
    shift
    log_info "Connecting to the VM ($(instance_ip))"
    vm_ssh_interactive "$@"
    exit $?
fi

if [ $# -gt 0 ]; then
    container_exec "cd /workspaces/echo && $*"
    exit $?
fi

log_info "Connecting to the devcontainer"
# -t forces a TTY through both hops so the interactive shell behaves.
# No `exec`: gc_ssh is a shell function, not a binary.
gc_ssh -- -t "cd '$RD_REPO_DIR/echo/.devcontainer' && docker compose exec devcontainer bash -lc 'cd /workspaces/echo && exec bash -l'"
