#!/usr/bin/env bash
# Builds the Slack alert relay (infra/alert-relay) and pushes it to one environment's
# registry, tagged with the hash of its sources: the tag Terraform computes, so an apply
# after a change to the relay fails until this has run. Also puts the Slack bot token in the
# environment's secret when it has no value yet, reading it from SLACK_BOT_TOKEN in
# ~/.config/sam/env without echoing it.
#   infra/alert-relay.sh <preview|next|prod>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  preview) project=dembrane-web-previews ;;
  next) project=dembrane-web-next ;;
  prod) project=dembrane-web-prod ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
env=$1
src=$here/alert-relay
tag=$(cd "$src" && export LC_ALL=C && for f in *; do sha256sum "$f" | cut -d' ' -f1; done | tr -d '\n' | sha256sum | cut -c1-12)
image=europe-west4-docker.pkg.dev/$project/echo-$env/alert-relay:$tag
docker buildx build --push --provenance=false --platform linux/amd64 -t "$image" "$src"

secret=echo-$env-alert-relay-slack-token
if [ -z "$(gcloud secrets versions list "$secret" --project "$project" --filter state=enabled --limit 1 --format 'value(name)')" ]; then
  grep '^SLACK_BOT_TOKEN=' ~/.config/sam/env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' |
    tr -d '\n' | gcloud secrets versions add "$secret" --project "$project" --data-file=- >/dev/null
  echo "$secret: token added"
fi
echo "$image"
