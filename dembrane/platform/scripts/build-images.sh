#!/usr/bin/env bash
# Builds the five images as $REGISTRY/<app>:$TAG, in parallel, from dembrane/platform.
#   build-images.sh --push [--cache-to]    push them (and write the GitHub Actions layer cache)
#   build-images.sh --load [--cache-to]    keep them in the local Docker daemon
# The layer cache is shared across jobs, so a deploy job pushing what the images job built
# moments ago only uploads.
set -euo pipefail
out=${1:?--push or --load}
cache_to=${2:-}
: "${REGISTRY:?}" "${TAG:?}"

build() {
  local app=$1
  shift
  # shellcheck disable=SC2086
  docker buildx build "$out" --provenance=false \
    --cache-from "type=gha,scope=$app" ${cache_to:+--cache-to "type=gha,mode=max,scope=$app"} \
    -f "apps/$app/Dockerfile" --build-arg "RELEASE=$TAG" -t "$REGISTRY/$app:$TAG" "$@"
}
build api . &
build worker . &
build migrate . --build-context demos=../demos &
build media . &
build web .. &
fail=0
for j in $(jobs -p); do wait "$j" || fail=1; done
exit $fail
