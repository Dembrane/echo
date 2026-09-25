#!/usr/bin/env bash
# Opens a shell in the devcontainer, or on the VM with --vm.
#
#   ./scripts/remote-dev.sh ssh                    shell inside the devcontainer, in /workspaces/echo
#   ./scripts/remote-dev.sh ssh --vm               shell on the VM itself (docker, logs, disk)
#   ./scripts/remote-dev.sh ssh --vm <command...>  run a command on the VM and exit
#   ./scripts/remote-dev.sh ssh --vm --flag...     extra flags go to gcloud compute ssh
#   ./scripts/remote-dev.sh ssh <command...>       run a command in the devcontainer and exit
#
# The devcontainer shell is a login shell, which matters: fnm, node, pnpm and
# uv are put on PATH by ~/.bashrc, so a non-login shell cannot find them.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

require_gcloud
require_running

if [ "${1:-}" = "--vm" ]; then
    shift
    log_info "Connecting to the VM ($(instance_ip))"
    # A leading flag is for gcloud, as in --command '...'. Anything else is a
    # command to run; -t so one like tail -f stops on ctrl-c.
    if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
        gc_ssh --command "$*" -- -t
    else
        vm_ssh_interactive "$@"
    fi
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
