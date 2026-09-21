#!/usr/bin/env bash
# Shared configuration for the remote dev VM.
#
# This file holds team-wide defaults only. Anything specific to one person
# (GCP project, instance name, preferred zone) has no default here and is
# written to local.env by ./init.sh on first run. local.env is gitignored.
#
# Precedence, highest first:
#   1. An env var:            RD_MACHINE_TYPE=c4-standard-16 ./create.sh
#   2. local.env              (written by ./init.sh, gitignored, per-person)
#   3. The defaults below     (team-wide, committed)
#
# Nothing here is secret. Secrets live in the .env files that sync-env.sh
# copies up, and those are never committed.

# --- Per-person. No defaults on purpose. Set by ./init.sh. ---------------

# The GCP project that owns the dev VM. Everyone runs their own sandbox
# project rather than sharing one, so there is deliberately no default: a
# wrong guess here bills someone else's project or fails confusingly.
: "${RD_PROJECT:=}"

# Zone drives SSH round-trip time, which is the single biggest factor in how
# a remote editor feels. Pick the zone closest to you, not the one closest to
# production. ./init.sh suggests one based on your machine's timezone.
: "${RD_ZONE:=}"

# --- Team-wide defaults. ./init.sh still confirms these interactively. ---

# The dembrane GCP organization. Contributors outside the org override this
# during init; it is only used to filter the project list ./init.sh offers.
: "${RD_ORG_DOMAIN:=dembrane.com}"
: "${RD_ORG_ID:=535152468605}"

# Instance names must be unique within a project and zone, so the default
# carries the system username. That way two people pointed at the same project
# do not collide, and an instance in a shared project says who owns it.
#
# GCE names allow lowercase letters, digits and hyphens only, and must start
# with a letter, so the username is slugged rather than used verbatim. `tr -c`
# also rewrites the trailing newline, hence the trim.
RD_USER_SLUG="$(whoami | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')"
: "${RD_INSTANCE_NAME:=dembrane-devbox-${RD_USER_SLUG}}"

# Start small and grow. Machine type is not baked into the disk, so ./resize.sh
# can move you up a size in about a minute (stop, change, start) without
# rebuilding anything. Paying for headroom you have not proven you need is the
# more expensive mistake.
#
# e2-standard-4 is 4 vCPU / 16GB. That comfortably runs the 5 containers and
# the API, but if you run all 7 mprocs entries at once (3 dramatiq workers,
# scheduler, and both vite dev servers) alongside a directus build, expect it
# to feel tight. Upsize when it actually hurts:
#
#   ./resize.sh e2-standard-8    # 8 vCPU / 32GB
#   ./resize.sh e2-standard-16   # 16 vCPU / 64GB
: "${RD_MACHINE_TYPE:=e2-standard-4}"

# Disks can grow online but can never shrink, so starting small is the only
# reversible choice. You also pay for the disk while the VM is stopped, which
# makes an oversized one the bill that never goes away.
#
# Measured steady state is around 20 to 25GB: ~4.3GB of Ubuntu and snaps,
# ~2.2GB for node_modules and the uv venv, ~10GB of images and build layers
# for the five compose services, and ~2GB of pnpm and uv caches. 50GB leaves
# roughly 2x headroom for docker build cache growing over months.
#
# Grow it with: ./resize.sh --disk 100GB
: "${RD_DISK_SIZE:=50GB}"
: "${RD_DISK_TYPE:=pd-balanced}"

: "${RD_IMAGE_FAMILY:=ubuntu-2404-lts-amd64}"
: "${RD_IMAGE_PROJECT:=ubuntu-os-cloud}"

# Where the repo lands on the VM. The compose file mounts `../..` (the
# dembrane-echo root) at /workspaces, and devcontainer.json sets
# workspaceFolder to /workspaces/echo, so the clone directory name here does
# not affect the in-container paths.
: "${RD_REMOTE_USER:=$(whoami)}"
: "${RD_REPO_DIR:=/home/${RD_REMOTE_USER}/dembrane-echo}"
: "${RD_REPO_URL:=https://github.com/dembrane/echo.git}"

# SSH host aliases written into ~/.ssh/config by ssh-config.sh.
# RD_SSH_HOST reaches the VM itself; RD_SSH_CONTAINER_HOST tunnels through it
# into the devcontainer's own sshd, which is what Zed should connect to.
#
# These deliberately do NOT carry the username the way RD_INSTANCE_NAME does.
# They are aliases in your own ~/.ssh/config, so there is nobody to collide
# with, and keeping them fixed means the Zed setup instructions and the docs
# name the same host for everyone.
: "${RD_SSH_HOST:=dembrane-devbox}"
: "${RD_SSH_CONTAINER_HOST:=dembrane-devcontainer}"

# The devcontainer's sshd, as published by docker-compose.yml (2222 -> 22).
# This port is never opened in the GCP firewall. It is only reachable by
# jumping through the VM's own sshd on port 22.
: "${RD_CONTAINER_SSH_PORT:=2222}"

# Ports forwarded to your laptop by tunnel.sh. These are deliberately
# identical on both ends: the compose file hardcodes localhost origins
# (CORS_ORIGIN=http://localhost:5173, PUBLIC_URL=http://localhost:8055), so
# keeping the same numbers locally means none of that config needs to change.
: "${RD_FORWARD_PORTS:=5173 5174 8000 8055 5432 9000 9001}"

# Compose files, relative to echo/.devcontainer/.
# Add docker-compose-s3.yml here if you need minio; the server is configured
# to talk to it (STORAGE_S3_ENDPOINT=http://minio:9000) but it is not in the
# base compose file.
: "${RD_COMPOSE_FILES:=docker-compose.yml}"

# Env files copied up by sync-env.sh, relative to the echo/ directory.
# directus/.env is required by the compose file; the others are optional.
: "${RD_ENV_FILES:=directus/.env server/.env agent/.env}"
