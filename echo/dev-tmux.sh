#!/bin/bash

# Echo Development Environment Tmux Setup Script
# This script sets up a complete tmux development environment with all services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Session name
SESSION_NAME="echo-dev"

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to install tmux
install_tmux() {
    print_status "Installing tmux..."
    
    # Check if we're running as root
    local is_root=false
    if [[ $EUID -eq 0 ]]; then
        is_root=true
    fi
    
    # Function to run commands with or without sudo
    run_cmd() {
        if [[ "$is_root" == true ]]; then
            "$@"
        else
            sudo "$@"
        fi
    }
    
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if command_exists apt-get; then
            if [[ "$is_root" == true ]]; then
                apt-get update && apt-get install -y tmux
            else
                sudo apt-get update && sudo apt-get install -y tmux
            fi
        elif command_exists yum; then
            run_cmd yum install -y tmux
        elif command_exists dnf; then
            run_cmd dnf install -y tmux
        elif command_exists pacman; then
            run_cmd pacman -S --noconfirm tmux
        elif command_exists zypper; then
            run_cmd zypper install -y tmux
        else
            print_error "No supported package manager found. Please install tmux manually."
            exit 1
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        if command_exists brew; then
            brew install tmux
        else
            print_error "Homebrew not found. Please install Homebrew first or install tmux manually."
            exit 1
        fi
    else
        print_error "Unsupported operating system. Please install tmux manually."
        exit 1
    fi
    
    print_status "Tmux installed successfully!"
}

# Function to create tmux configuration
create_tmux_config() {
    local config_file="$HOME/.tmux.conf"
    
    # Check if config already exists
    if [[ -f "$config_file" ]]; then
        print_warning "Tmux configuration already exists at $config_file"
        read -p "Do you want to replace it with vim-style config? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_status "Keeping existing configuration"
            return
        fi
        print_status "Removing existing configuration..."
        rm "$config_file"
    fi
    
    print_status "Creating vim-style tmux configuration..."
    
    # Create comprehensive vim-style tmux configuration
    cat > "$config_file" << 'EOF'
# Vim-style tmux configuration for Echo Development Environment

# =============================================================================
# BASIC SETTINGS
# =============================================================================

# Enable mouse support
set -g mouse on

# Set leader key to Ctrl+a
set -g prefix C-a
unbind C-b
bind C-a send-prefix

# Set base index to 0 (default)
set -g base-index 0
setw -g pane-base-index 0

# Increase scrollback buffer size
set -g history-limit 10000

# Enable vi mode
setw -g mode-keys vi

# =============================================================================
# VIM-STYLE NAVIGATION (hjkl)
# =============================================================================

# Pane navigation with hjkl
bind h select-pane -L
bind j select-pane -D
bind k select-pane -U
bind l select-pane -R

# Window navigation with hjkl
bind -n C-h select-window -t :-
bind -n C-l select-window -t :+

# =============================================================================
# VIM-STYLE COPY MODE (Ctrl+a [)
# =============================================================================

# Enter copy mode
bind [ copy-mode

# Vim-style movement in copy mode
bind-key -T copy-mode-vi h send -X cursor-left
bind-key -T copy-mode-vi j send -X cursor-down
bind-key -T copy-mode-vi k send -X cursor-up
bind-key -T copy-mode-vi l send -X cursor-right

# Vim-style word movement
bind-key -T copy-mode-vi w send -X next-word
bind-key -T copy-mode-vi b send -X previous-word
bind-key -T copy-mode-vi e send -X next-word-end

# Vim-style line movement
bind-key -T copy-mode-vi 0 send -X start-of-line
bind-key -T copy-mode-vi $ send -X end-of-line
bind-key -T copy-mode-vi ^ send -X start-of-line
bind-key -T copy-mode-vi g send -X history-top
bind-key -T copy-mode-vi G send -X history-bottom

# Vim-style page movement
bind-key -T copy-mode-vi C-u send -X halfpage-up
bind-key -T copy-mode-vi C-d send -X halfpage-down
bind-key -T copy-mode-vi C-b send -X page-up
bind-key -T copy-mode-vi C-f send -X page-down

# =============================================================================
# VIM-STYLE SELECTION AND COPY
# =============================================================================

# Start selection with v (visual mode)
bind-key -T copy-mode-vi v send -X begin-selection

# Start line selection with V (visual line mode)
bind-key -T copy-mode-vi V send -X select-line

# Start block selection with C-v (visual block mode)
bind-key -T copy-mode-vi C-v send -X rectangle-toggle

# Yank selection to tmux buffer
bind-key -T copy-mode-vi y send -X copy-selection

# Yank line to tmux buffer
bind-key -T copy-mode-vi Y send -X copy-line

# =============================================================================
# VIM-STYLE SEARCH
# =============================================================================

# Search forward/backward
bind-key -T copy-mode-vi / command-prompt -T copy-mode-vi -I "#{pane_search_string}" "send -X search-forward-incremental \"%%%\""
bind-key -T copy-mode-vi ? command-prompt -T copy-mode-vi -I "#{pane_search_string}" "send -X search-backward-incremental \"%%%\""

# Next/previous search result
bind-key -T copy-mode-vi n send -X search-again
bind-key -T copy-mode-vi N send -X search-reverse

# =============================================================================
# VIM-STYLE EDITING COMMANDS
# =============================================================================

# Delete selection
bind-key -T copy-mode-vi d send -X delete-selection

# Change selection (delete and enter insert mode)
bind-key -T copy-mode-vi c send -X delete-selection

# =============================================================================
# WINDOW AND PANE MANAGEMENT
# =============================================================================

# Create new window
bind c new-window -c "#{pane_current_path}"

# Close current window
bind x kill-window

# Rename current window
bind r command-prompt -I "#W" "rename-window '%%'"

# Split panes with vim-style keys
bind | split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"

# Close current pane
bind q kill-pane

# Toggle pane zoom
bind z resize-pane -Z

# =============================================================================
# WINDOW SWITCHING
# =============================================================================

# Quick window switching with F keys
bind-key -n F1 select-window -t :0
bind-key -n F2 select-window -t :1
bind-key -n F3 select-window -t :2
bind-key -n F4 select-window -t :3
bind-key -n F5 select-window -t :4

# Window switching with numbers
bind-key -n M-1 select-window -t :0
bind-key -n M-2 select-window -t :1
bind-key -n M-3 select-window -t :2
bind-key -n M-4 select-window -t :3
bind-key -n M-5 select-window -t :4

# =============================================================================
# PANE RESIZING
# =============================================================================

# Resize panes with hjkl
bind -r H resize-pane -L 5
bind -r J resize-pane -D 5
bind -r K resize-pane -U 5
bind -r L resize-pane -R 5

# Resize panes with arrow keys
bind -r Left resize-pane -L 5
bind -r Down resize-pane -D 5
bind -r Up resize-pane -U 5
bind -r Right resize-pane -R 5

# =============================================================================
# UTILITY COMMANDS
# =============================================================================

# Reload config
bind R source-file ~/.tmux.conf \; display "Config reloaded!"

# Show key bindings
bind ? list-keys

# Synchronize panes
bind y set-window-option synchronize-panes

# Toggle status bar
bind b set-option status

# =============================================================================
# STATUS BAR CUSTOMIZATION
# =============================================================================

# Status bar colors
set -g status-style bg=colour235,fg=colour136,default

# Window status colors
setw -g window-status-current-style bg=colour136,fg=colour235
setw -g window-status-style bg=colour235,fg=colour136

# Pane border colors
set -g pane-border-style bg=colour235,fg=colour238
set -g pane-active-border-style bg=colour235,fg=colour136

# Status bar content
set -g status-left-length 40
set -g status-left "#[fg=green]#S #[fg=black]• #[fg=green,bright]#(uname -r | cut -c 1-6)#[default]"

set -g status-right-length 60
set -g status-right "#[fg=colour136]#(cut -d ' ' -f 1-3 /proc/loadavg)#[default] #[fg=colour33]%H:%M#[default]"

# Center the window list
set -g status-justify centre

# =============================================================================
# PERFORMANCE OPTIMIZATIONS
# =============================================================================

# Faster key repeat
set -s escape-time 0

# Focus events
set -g focus-events on

# Aggressive resize
setw -g aggressive-resize on
EOF

    print_status "Vim-style tmux configuration created at $config_file"
}

# Function to check if session exists
session_exists() {
    tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

# Function to kill existing session
kill_session() {
    if session_exists; then
        print_warning "Session '$SESSION_NAME' already exists. Killing it..."
        tmux kill-session -t "$SESSION_NAME"
        sleep 1
    fi
}

# Function to create the development session
create_session() {
    print_status "Creating tmux session '$SESSION_NAME'..."
    
    # Get the absolute path to the project root
    local project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    # Create new session with first window
    tmux new-session -d -s "$SESSION_NAME" -n "server" -c "$project_root"
    
    # Window 1: Server
    tmux send-keys -t "$SESSION_NAME:server" "cd server && source .venv/bin/activate && ./run.sh" C-m
    
    # Window 2: Workers and Scheduler (split 80/20)
    tmux new-window -t "$SESSION_NAME" -n "workers" -c "$project_root"
    
    # Split the workers window horizontally (80% workers, 20% scheduler)
    tmux split-window -t "$SESSION_NAME:workers" -h -p 80 -c "$project_root"
    tmux split-window -t "$SESSION_NAME:workers" -h -p 20 -c "$project_root"
    
    # Rename the panes for clarity
    tmux select-pane -t "$SESSION_NAME:workers.0" -T "workers"
    tmux select-pane -t "$SESSION_NAME:workers.1" -T "workers-cpu"
    tmux select-pane -t "$SESSION_NAME:workers.2" -T "scheduler"
    
    # Send commands to each pane
    tmux send-keys -t "$SESSION_NAME:workers.0" "cd server && source .venv/bin/activate && ./run-worker.sh" C-m
    tmux send-keys -t "$SESSION_NAME:workers.1" "cd server && source .venv/bin/activate && ./run-worker-cpu.sh" C-m
    tmux send-keys -t "$SESSION_NAME:workers.2" "cd server && source .venv/bin/activate && ./run-scheduler.sh" C-m
    
    # Window 3: Frontends
    tmux new-window -t "$SESSION_NAME" -n "frontends" -c "$project_root"
    
    # Split the frontends window vertically
    tmux split-window -t "$SESSION_NAME:frontends" -v -c "$project_root"
    
    # Rename the panes for clarity
    tmux select-pane -t "$SESSION_NAME:frontends.0" -T "admin-dashboard"
    tmux select-pane -t "$SESSION_NAME:frontends.1" -T "participant-portal"
    
    # Send commands to each pane
    tmux send-keys -t "$SESSION_NAME:frontends.0" "cd frontend && pnpm run dev" C-m
    tmux send-keys -t "$SESSION_NAME:frontends.1" "cd frontend && pnpm run participant:dev" C-m
    
    # Set window layout for better organization
    tmux select-window -t "$SESSION_NAME:server"
    
    print_status "Session created successfully!"
}

# Function to attach to session
attach_session() {
    print_status "Attaching to session '$SESSION_NAME'..."
    tmux attach-session -t "$SESSION_NAME"
}

# Function to show session info
show_session_info() {
    print_status "Session Information:"
    echo "  Session Name: $SESSION_NAME"
    echo "  Windows:"
    echo "    1. server - Main server process"
    echo "    2. workers - Workers and scheduler (80/20 split)"
    echo "       - workers: Network workers"
    echo "       - workers-cpu: CPU workers"
    echo "       - scheduler: Task scheduler"
    echo "    3. frontends - Frontend applications"
    echo "       - admin-dashboard: Admin interface"
    echo "       - participant-portal: Participant interface"
    echo ""
    echo "  Vim-Style Navigation:"
    echo "    hjkl        - Navigate between panes"
    echo "    Ctrl+h/l    - Navigate between windows"
    echo "    Ctrl+a [    - Enter copy mode (vim-style)"
    echo ""
    echo "  Copy Mode (Ctrl+a [):"
    echo "    hjkl        - Move cursor"
    echo "    w/b/e       - Word movement"
    echo "    0/$/^       - Line start/end"
    echo "    g/G         - Buffer start/end"
    echo "    v/V/C-v     - Visual/line/block selection"
    echo "    y/Y         - Yank selection/line"
    echo "    /?          - Search forward/backward"
    echo "    n/N         - Next/previous search"
    echo ""
    echo "  Window Management:"
    echo "    Ctrl+a c    - Create new window"
    echo "    Ctrl+a x    - Close current window"
    echo "    Ctrl+a r    - Rename window"
    echo "    F1-F5       - Switch to windows 1-5"
    echo "    Alt+1-5     - Switch to windows 1-5"
    echo ""
    echo "  Pane Management:"
    echo "    Ctrl+a |    - Split pane horizontally"
    echo "    Ctrl+a -    - Split pane vertically"
    echo "    Ctrl+a q    - Close current pane"
    echo "    Ctrl+a z    - Toggle pane zoom"
    echo "    H/J/K/L     - Resize panes"
    echo ""
    echo "  Utility:"
    echo "    Ctrl+a R    - Reload config"
    echo "    Ctrl+a ?    - Show key bindings"
    echo "    Ctrl+a y    - Toggle pane sync"
    echo "    Ctrl+a b    - Toggle status bar"
    echo ""
    echo "  Mouse support is enabled"
    echo "  Use Ctrl+a d to detach from session"
}

# Function to show help
show_help() {
    echo "Echo Development Environment Tmux Setup Script"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -h, --help          Show this help message"
    echo "  -i, --install       Install tmux if not present"
    echo "  -c, --config        Create/update tmux configuration"
    echo "  -k, --kill          Kill existing session"
    echo "  -a, --attach        Attach to existing session"
    echo "  -n, --new           Create new session (default)"
    echo "  -s, --status        Show session status"
    echo "  -f, --force         Force recreate session (kill + new)"
    echo ""
    echo "Examples:"
    echo "  $0                  # Create new session and attach"
    echo "  $0 -i               # Install tmux and create session"
    echo "  $0 -k               # Kill existing session"
    echo "  $0 -a               # Attach to existing session"
    echo "  $0 -f               # Force recreate session"
}

# Main function
main() {
    local install_tmux_flag=false
    local create_config_flag=false
    local kill_session_flag=false
    local attach_only_flag=false
    local new_session_flag=false
    local show_status_flag=false
    local force_flag=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -i|--install)
                install_tmux_flag=true
                shift
                ;;
            -c|--config)
                create_config_flag=true
                shift
                ;;
            -k|--kill)
                kill_session_flag=true
                shift
                ;;
            -a|--attach)
                attach_only_flag=true
                shift
                ;;
            -n|--new)
                new_session_flag=true
                shift
                ;;
            -s|--status)
                show_status_flag=true
                shift
                ;;
            -f|--force)
                force_flag=true
                shift
                ;;
            *)
                print_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    # Default behavior if no flags specified
    if [[ "$install_tmux_flag" == false && "$create_config_flag" == false && "$kill_session_flag" == false && "$attach_only_flag" == false && "$new_session_flag" == false && "$show_status_flag" == false && "$force_flag" == false ]]; then
        new_session_flag=true
    fi
    
    # Check if tmux is installed
    if ! command_exists tmux; then
        if [[ "$install_tmux_flag" == true ]]; then
            install_tmux
        else
            print_error "Tmux is not installed. Use -i flag to install it automatically."
            exit 1
        fi
    fi
    
    # Create/update tmux configuration
    if [[ "$create_config_flag" == true ]]; then
        create_tmux_config
    fi
    
    # Show session status
    if [[ "$show_status_flag" == true ]]; then
        if session_exists; then
            print_status "Session '$SESSION_NAME' exists"
            tmux list-sessions
        else
            print_warning "Session '$SESSION_NAME' does not exist"
        fi
        show_session_info
        exit 0
    fi
    
    # Kill session if requested
    if [[ "$kill_session_flag" == true || "$force_flag" == true ]]; then
        kill_session
    fi
    
    # Attach to existing session
    if [[ "$attach_only_flag" == true ]]; then
        if session_exists; then
            attach_session
        else
            print_error "Session '$SESSION_NAME' does not exist. Create it first with -n flag."
            exit 1
        fi
        exit 0
    fi
    
    # Create new session
    if [[ "$new_session_flag" == true || "$force_flag" == true ]]; then
        create_session
        show_session_info
        attach_session
    fi
}

# Run main function with all arguments
main "$@" 