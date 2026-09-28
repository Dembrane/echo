#!/bin/bash
# Startup script for the VM that runs the Storage Transfer agents (Container-Optimized OS).
# The agents read Spaces with keys from Secret Manager and write to GCS as the VM's service
# account, so no key file exists anywhere. Home and office uplinks move ~5 MB/s; a VM in
# europe-west4 is what makes a multi-TiB copy fit in days, not weeks.
#
# Metadata attributes (set by ops/transfer-agents.sh):
#   agent-pool     STS agent pool name
#   spaces-secret  Secret Manager secret holding AWS_ACCESS_KEY_ID= and AWS_SECRET_ACCESS_KEY= lines
#   agents         how many agent containers to run (default 4)
set -euo pipefail
md() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
project="$(md project/project-id)"
pool="$(md instance/attributes/agent-pool)"
secret="$(md instance/attributes/spaces-secret)"
agents="$(md instance/attributes/agents || echo 4)"
# No jq or python on Container-Optimized OS: flatten the JSON, then cut the field out.
field() { tr -d ' \n' | sed -E "s/.*\"$1\":\"([^\"]+)\".*/\1/"; }
token="$(md instance/service-accounts/default/token | field access_token)"
env_file=/run/spaces.env
curl -sf -H "Authorization: Bearer $token" \
  "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$secret/versions/latest:access" |
  field data | base64 -d > "$env_file"
chmod 600 "$env_file"
for i in $(seq 1 "$agents"); do
  docker rm -f "sts-agent-$i" >/dev/null 2>&1 || true
  docker run -d --name "sts-agent-$i" --restart unless-stopped --network host \
    --ulimit memlock=64000000 --env-file "$env_file" \
    gcr.io/cloud-ingest/tsop-agent:latest \
    --project-id="$project" --agent-pool="$pool" --hostname="$(hostname)" --agent-id-prefix="$(hostname)-$i-"
done
