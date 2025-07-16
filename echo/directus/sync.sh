#!/bin/bash

# Default values
DEFAULT_URL="http://directus:8055"
DEFAULT_USERNAME="admin@dembrane.com"
DEFAULT_PASSWORD="admin"

# Initialize variables
url=""
username=""
password=""
action=""
force="false"

# Function to show usage
show_usage() {
    echo "Usage: $0 [-u URL] [-e USERNAME] [-p PASSWORD] [-f] ACTION"
    echo "Actions: push, pull, diff"
    echo "Flags: -f, --force"
    echo "If parameters are not provided, you will be prompted for them."
    exit 1
}

# Parse command line arguments
while getopts "u:e:p:fv:h" opt; do
    case $opt in
        u) url="$OPTARG" ;;
        e) username="$OPTARG" ;;
        p) password="$OPTARG" ;;
        f) force="true" ;;
        h) show_usage ;;
        ?) show_usage ;;
    esac
done

# Get the action from remaining arguments
shift $((OPTIND-1))
action="$1"

# Validate action
if [[ ! "$action" =~ ^(push|pull|diff)$ ]]; then
    if [ -z "$action" ]; then
        # Prompt for action if not provided
				echo "definitions: push (from source to directus), pull (from directus to source), diff (from source to directus)"
                echo "LHS: server, RHS: source"
        echo "Select action:"
        select action in "push" "pull" "diff"; do
            if [ -n "$action" ]; then
                break
            fi
        done
    else
        echo "Invalid action: $action"
        show_usage
    fi
fi

# Prompt for missing values
if [ -z "$url" ]; then
    read -p "Enter URL [$DEFAULT_URL]: " url
    url=${url:-$DEFAULT_URL}
fi

if [ -z "$username" ]; then
    read -p "Enter username [$DEFAULT_USERNAME]: " username
    username=${username:-$DEFAULT_USERNAME}
fi

if [ -z "$password" ]; then
    read -s -p "Enter password [$DEFAULT_PASSWORD]: " password
    echo
    password=${password:-$DEFAULT_PASSWORD}
fi

# Execute directus-sync command
if [ "$force" = "true" ]; then
    npx -y directus-sync -u "$url" -e "$username" -p "$password" "$action" -d -f
else
    npx -y directus-sync -u "$url" -e "$username" -p "$password" "$action" -d
fi
