#!/usr/bin/env bash
# Builds the five images as $REGISTRY/$IMAGE_PREFIX<app>:$TAG, in parallel, from dembrane/platform.
#
#   build-images.sh --load [app...]    build into the local Docker daemon (no registry needed)
#   build-images.sh --push [app...]    make $REGISTRY/$IMAGE_PREFIX<app>:$TAG exist for every app (default all)
#   build-images.sh key <app>          print the app's input key
#   build-images.sh changed <base> [<head>]  the apps whose inputs differ between two commits
#
# Every image is also tagged src-<key>, where the key hashes the files that go into it (see
# inputs below). --push first looks for src-<key> in the registry: when it is there, the image
# is only tagged $TAG (a manifest copy, a second or two) instead of being built and uploaded
# again, so a frontend-only change reuses the four server images and the reverse (the key reads
# committed files at HEAD, not the working tree). --push also loads what it builds, so the
# smoke test runs on the exact image that was pushed.
#
# The images carry APP_RELEASE only as a default: every deploy sets it per service, so an image
# reused from an older commit still reports the commit it was deployed from.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
platform="$repo/dembrane/platform"
ALL_APPS="api worker migrate media web"
# Bump when a build argument or the build command changes what an image holds.
KEY_VERSION=1
# Empty on GCP, where each environment has its own repository; prod's DigitalOcean registry is
# shared with the old stack, so its images are named dembrane-web-<app>.
IMAGE_PREFIX=${IMAGE_PREFIX:-}
img() { echo "$REGISTRY/$IMAGE_PREFIX$1"; }

# The paths each image is built from, relative to the repository root. Files that never reach
# an image are left out, so changing them builds nothing: infrastructure, CI scripts and tests.
inputs() {
  case $1 in
    api | worker | migrate | media) echo dembrane/platform ;;
    web) echo dembrane/platform dembrane/frontend ;;
    *) echo "unknown app: $1" >&2; exit 2 ;;
  esac
}
IGNORED='^dembrane/platform/scripts/|/(test|tests|e2e)/|\.test\.tsx?$'

key() {
  local app=$1
  # shellcheck disable=SC2046
  {
    echo "$KEY_VERSION $app"
    # path<TAB>blob id, for every file under the app's inputs that can change it.
    git -C "$repo" ls-tree -r HEAD -- $(inputs "$app") | awk -F'\t' '{ split($1, m, " "); print $2 "\t" m[3] }' |
      filter_paths
  } | sha256sum | cut -c1-24
}

# Keeps the lines (path first) that can change an image.
filter_paths() {
  awk -v ignored="$IGNORED" -F'\t' '$1 !~ ignored'
}

changed() {
  local base=$1 head=${2:-HEAD} app files
  files=$(git -C "$repo" diff --no-renames --name-only "$base" "$head" | filter_paths)
  # A change to how images are built rebuilds all of them.
  if grep -qE '^\.github/scripts/build-images\.sh$|^dembrane/platform/apps/[^/]+/Dockerfile$' \
    <<<"$(git -C "$repo" diff --no-renames --name-only "$base" "$head")"; then
    echo "$ALL_APPS"
    return
  fi
  local picked=()
  for app in $ALL_APPS; do
    for p in $(inputs "$app"); do
      if grep -q "^$p/" <<<"$files"; then picked+=("$app"); break; fi
    done
  done
  echo "${picked[*]}"
}

exists() { docker buildx imagetools inspect "$1" >/dev/null 2>&1; }

build() {
  local out=$1 app=$2 k=$3 ctx extra=()
  case $app in
    web) ctx=.. ;;
    *) ctx=. ;;
  esac
  local tags=(-t "$(img "$app"):$TAG" -t "$(img "$app"):src-$k")
  local outputs=(--load)
  [ "$out" = --push ] && outputs=(--load --push)
  (cd "$platform" && docker buildx build "${outputs[@]}" --provenance=false \
    -f "apps/$app/Dockerfile" --build-arg "RELEASE=$TAG" "${tags[@]}" "${extra[@]}" "$ctx")
}

run() {
  local out=$1 app k
  shift
  local apps=("$@")
  [ ${#apps[@]} -gt 0 ] || read -ra apps <<<"$ALL_APPS"
  : "${REGISTRY:?}" "${TAG:?}"
  local pids=() names=()
  : >"${BUILT_FILE:=/dev/null}"
  for app in "${apps[@]}"; do
    k=$(key "$app")
    if [ "$out" = --push ] && exists "$(img "$app"):src-$k"; then
      echo "$app: reusing src-$k (its inputs did not change)"
      # A manifest copy under the new tag, so the deploy names every image by this commit.
      docker buildx imagetools create --prefer-index=false -t "$(img "$app"):$TAG" "$(img "$app"):src-$k" &
    else
      echo "$app: building src-$k"
      echo "$app" >>"$BUILT_FILE"
      build "$out" "$app" "$k" &
    fi
    pids+=($!) names+=("$app")
  done
  local fail=0 i
  for i in "${!pids[@]}"; do wait "${pids[$i]}" || { echo "${names[$i]} failed" >&2; fail=1; }; done
  return $fail
}

case "${1:-}" in
  --load | --push) mode=$1; shift; run "$mode" "$@" ;;
  key) key "$2" ;;
  changed) changed "$2" "${3:-HEAD}" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
