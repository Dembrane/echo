#!/bin/bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22}"
PYTHON_VERSION="${PYTHON_VERSION:-3.11}"
PNPM_STORE="${PNPM_STORE:-/home/node/.local/share/pnpm/store}"
FNM_DIR="$HOME/.local/share/fnm"
UV_BIN_DIR="$HOME/.local/bin"
BASHRC="$HOME/.bashrc"

APT_UPDATED="false"
ORIGINAL_DIR="$(pwd)"
trap 'cd "$ORIGINAL_DIR"' EXIT

log_info() {
    echo -e "\033[0;32m[INFO]\033[0m $1"
}

log_warn() {
    echo -e "\033[1;33m[WARN]\033[0m $1"
}

log_error() {
    echo -e "\033[0;31m[ERROR]\033[0m $1" >&2
}

command_exists() {
    command -v "$1" &> /dev/null 2>&1
}

ensure_apt_packages() {
    local missing=()
    for pkg in "$@"; do
        dpkg -s "$pkg" &> /dev/null || missing+=("$pkg")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        if [ "$APT_UPDATED" = "false" ]; then
            log_info "Updating apt package index..."
            apt-get update -qq
            APT_UPDATED="true"
        fi
        log_info "Installing apt packages: ${missing[*]}"
        apt-get install -y "${missing[@]}"
    fi
}

ensure_line_in_file() {
    local file="$1" line="$2"
    mkdir -p "$(dirname "$file")"
    touch "$file"
    grep -Fqx "$line" "$file" 2>/dev/null || echo "$line" >> "$file"
}

safe_pushd() {
    local dir="$1"
    if [ -d "$dir" ]; then
        pushd "$dir" > /dev/null
    else
        log_error "Directory not found: $dir"
        return 1
    fi
}

safe_popd() {
    popd > /dev/null || true
}

install_fnm() {
    if command_exists fnm; then
        log_info "fnm already installed: $(fnm --version)"
        return
    fi

    ensure_apt_packages curl ca-certificates
    log_info "Installing fnm..."
    curl -fsSL https://fnm.vercel.app/install | bash

    ensure_line_in_file "$BASHRC" 'eval "$(fnm env --use-on-cd)"'
    log_info "fnm installed"
}

activate_fnm_env() {
    if [ -d "$FNM_DIR" ]; then
        export PATH="$FNM_DIR:$PATH"
    fi
    command_exists fnm && eval "$(fnm env --use-on-cd)" 2>/dev/null || true
}

install_node() {
    activate_fnm_env

    if command_exists node && [[ $(node --version) == v${NODE_VERSION}* ]]; then
        log_info "Node.js already installed: $(node --version)"
        return
    fi

    if ! command_exists fnm; then
        log_error "fnm not found, cannot install Node.js"
        return 1
    fi

    log_info "Installing Node.js ${NODE_VERSION} via fnm..."
    fnm install "$NODE_VERSION" || log_warn "Node.js ${NODE_VERSION} may already be installed"
    fnm default "$NODE_VERSION" || true
    fnm use "$NODE_VERSION" || true
    log_info "Node.js ready: $(node --version)"
}

install_pnpm() {
    if command_exists pnpm; then
        log_info "pnpm already installed: $(pnpm --version)"
        return
    fi

    if ! command_exists npm; then
        log_error "npm not found, cannot install pnpm"
        return 1
    fi

    log_info "Installing pnpm globally..."
    npm install -g pnpm
    pnpm config set store-dir "$PNPM_STORE" || true
    log_info "pnpm installed: $(pnpm --version)"
}

install_uv() {
    if command_exists uv; then
        log_info "uv already installed: $(uv --version)"
        return
    fi

    ensure_apt_packages curl ca-certificates
    log_info "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh

    ensure_line_in_file "$BASHRC" 'source "$HOME/.local/bin/env"'

    if [ -f "$UV_BIN_DIR/env" ]; then
        source "$UV_BIN_DIR/env"
    elif [ -f "$UV_BIN_DIR/env.fish" ]; then
        source "$UV_BIN_DIR/env.fish" 2>/dev/null || true
    fi
    export PATH="$UV_BIN_DIR:$PATH"
    log_info "uv installed: $(uv --version)"
}

ensure_uv_python() {
    if ! command_exists uv; then
        log_error "uv not available"
        return 1
    fi

    if ! uv python list 2>/dev/null | grep -q "${PYTHON_VERSION}"; then
        log_info "Installing Python ${PYTHON_VERSION} via uv..."
        uv python install "${PYTHON_VERSION}"
    else
        log_info "Python ${PYTHON_VERSION} already installed via uv"
    fi
}

pin_uv_python() {
    local target_dir="$1"
    ensure_uv_python

    if safe_pushd "$target_dir"; then
        if uv python pin "${PYTHON_VERSION}" 2>/dev/null; then
            log_info "Pinned Python ${PYTHON_VERSION} for $(basename "$target_dir")"
        elif [ -f .python-version ]; then
            log_info "Python already pinned for $(basename "$target_dir")"
        else
            log_warn "Failed to pin Python for $(basename "$target_dir")"
        fi
        safe_popd
    fi
}

install_frontend_deps() {
    local dir="$WORKSPACE_ROOT/frontend"
    if [ ! -d "$dir" ]; then
        log_warn "Frontend directory not found, skipping"
        return
    fi

    if ! command_exists pnpm; then
        log_error "pnpm not available, skipping frontend dependency installation"
        return 1
    fi

    log_info "Installing frontend dependencies (pnpm)..."
    if safe_pushd "$dir"; then
        pnpm install --frozen-lockfile || pnpm install
        safe_popd
        log_info "Frontend dependencies installed"
    fi
}

install_server_deps() {
    local dir="$WORKSPACE_ROOT/server"
    if [ ! -d "$dir" ]; then
        log_warn "Server directory not found, skipping"
        return
    fi

    if ! command_exists uv; then
        log_error "uv not available, cannot install server dependencies"
        return 1
    fi

    pin_uv_python "$dir"

    log_info "Installing server dependencies (uv sync)..."
    if safe_pushd "$dir"; then
        uv sync || {
            log_error "uv sync failed"
            safe_popd
            return 1
        }
        safe_popd
        log_info "Server dependencies installed"
    fi
}

show_help() {
    cat <<EOF
Usage: ./setup.sh [options]

Options:
  -h, --help          Show this help message
  --skip-node         Skip fnm/Node.js/pnpm installation
  --skip-frontend     Skip frontend dependency installation
  --skip-server       Skip server dependency installation
  --skip-python       Skip managed Python setup for uv

Environment overrides:
  NODE_VERSION (default: ${NODE_VERSION})
  PYTHON_VERSION (default: ${PYTHON_VERSION})
  PNPM_STORE (default: ${PNPM_STORE})
EOF
}

parse_args() {
    SKIP_NODE="false"
    SKIP_FRONTEND="false"
    SKIP_SERVER="false"
    SKIP_PYTHON="false"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                show_help
                exit 0
                ;;
            --skip-node)
                SKIP_NODE="true"
                shift
                ;;
            --skip-frontend)
                SKIP_FRONTEND="true"
                shift
                ;;
            --skip-server)
                SKIP_SERVER="true"
                shift
                ;;
            --skip-python)
                SKIP_PYTHON="true"
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

resolve_workspace_root() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [[ "$script_dir" == *"/.devcontainer" ]]; then
        WORKSPACE_ROOT="$(cd "$script_dir/.." && pwd)"
    else
        WORKSPACE_ROOT="$script_dir"
    fi

    if [ ! -d "$WORKSPACE_ROOT" ]; then
        if [ -d "/workspaces/echo" ]; then
            WORKSPACE_ROOT="/workspaces/echo"
        elif [ -d "/workspace" ]; then
            WORKSPACE_ROOT="/workspace"
        else
            log_error "Unable to determine workspace root"
            exit 1
        fi
    fi

    cd "$WORKSPACE_ROOT"
    export WORKSPACE_ROOT
    log_info "Changed to workspace root: $WORKSPACE_ROOT"
}

main() {
    parse_args "$@"
    resolve_workspace_root

    if [ "$SKIP_NODE" = "false" ]; then
        install_fnm
        install_node
        install_pnpm
    else
        log_info "Skipping Node.js tooling setup"
    fi

    install_uv

    if [ "$SKIP_PYTHON" = "false" ]; then
        ensure_uv_python
    else
        log_info "Skipping Python setup"
    fi

    if [ "$SKIP_FRONTEND" = "false" ]; then
        install_frontend_deps
    else
        log_info "Skipping frontend dependencies"
    fi

    if [ "$SKIP_SERVER" = "false" ]; then
        install_server_deps
    else
        log_info "Skipping server dependencies"
    fi

    log_info "Setup complete!"
}

main "$@"

