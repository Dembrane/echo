#!/usr/bin/env bash
# Deploys a celld app from your laptop to the VM's celld, through the tunnel.
#
#   ./scripts/remote-dev.sh celld-deploy ../celld-apps/counter
#   ./scripts/remote-dev.sh celld-deploy DIR --dry-run  other celld deploy flags pass through
#
# celld deploy needs no server address: it bundles the Worker with esbuild and
# writes it to the fleet bucket, and the running node picks it up within a few
# seconds (CELLD_DEPLOY_POLL_S in docker-compose-celld.yml). So all this needs
# is minio's S3 API, which tunnel forwards to localhost:9000.

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
handle_help "${1:-}" "$0"

celld_enabled || die "celld is off. To enable it, $RD_CELLD_ENABLE_HINT"
command -v celld >/dev/null || die "celld is not on PATH. Install it with: curl -fsSL https://celld.dev/install.sh | sh"
command -v esbuild >/dev/null || die "esbuild is not on PATH. Install it with: pnpm add --global esbuild"
nc -z localhost 9000 2>/dev/null || die "Nothing answers on localhost:9000. Run ./scripts/remote-dev.sh tunnel in another tab first."

# The same bucket and credentials docker-compose-celld.yml gives the node.
export CELLD_BUCKET=s3://celld
export S3_ENDPOINT=http://localhost:9000
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=dembrane
export AWS_SECRET_ACCESS_KEY=dembrane

exec celld deploy "$@"
