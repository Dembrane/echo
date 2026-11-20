# Shared by the verify-dembrane scripts. Sourced, not run.
ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
PLATFORM=$ROOT/dembrane/platform
FRONTEND=$ROOT/dembrane/frontend
RUNS=$PLATFORM/.data/verify
SCRIPTS=$ROOT/.agents/skills/verify-dembrane/scripts

# Loads the run's env file: $VERIFY_RUN, or the only run there is. Several runs can be up at
# once (other agents, other worktrees), so with more than one it refuses to guess.
pick_run() {
  local run=${VERIFY_RUN:-} runs n
  if [ -z "$run" ]; then
    runs=$(ls -1 "$RUNS" 2>/dev/null || true)
    n=$(printf '%s\n' "$runs" | grep -c . || true)
    if [ "$n" -ne 1 ]; then
      echo "found $n verify runs under $RUNS; set VERIFY_RUN to the one you started:" >&2
      [ -z "$runs" ] || printf '  %s\n' $runs >&2
      return 1
    fi
    run=$runs
  fi
  [ -f "$RUNS/$run/env" ] || { echo "no verify run $run under $RUNS" >&2; return 1; }
  # shellcheck disable=SC1090
  . "$RUNS/$run/env"
}

# Lists every missing prerequisite at once, so nothing gets created before a fix. Needs no run.
preflight() {
  local missing=() c
  command -v ffmpeg >/dev/null 2>&1 || echo "warning: no ffmpeg on PATH; portal recordings will fail" >&2
  for c in bun curl lsof agent-browser; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c on PATH")
  done
  [ -d "$FRONTEND/node_modules" ] || missing+=("dembrane/frontend/node_modules (pnpm install)")
  [ -d "$PLATFORM/node_modules" ] || missing+=("dembrane/platform/node_modules (bun install)")
  if ! docker info >/dev/null 2>&1; then
    command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost -p 5432 ||
      missing+=("docker, or Postgres with pgvector on :5432 (see 'Run it without docker' in dembrane/platform/README.md)")
  fi
  [ ${#missing[@]} -eq 0 ] && return 0
  echo "verify-dembrane is missing:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  return 1
}

# Chrome's sandbox needs unprivileged user namespaces, which Ubuntu 23.10 and later restrict
# through AppArmor. Prints the agent-browser launch args that host needs, if any.
# Every launch gets the same flags. agent-browser restarts the browser whenever a command's
# flags differ from the running ones, and every helper reloads the env file, so flags given
# once with --args are dropped on the next helper call. The fake microphone is harmless on
# the dashboard, so it's always on.
browser_args() {
  local args=--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream
  [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && args=--no-sandbox,$args
  echo "$args"
}

listener_pid() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }

# Claims the first port from $1 up that nothing listens on and no other run has claimed.
# mkdir is atomic, so two runs starting together never get the same port. A claim whose run
# no longer exists is stale and gets reused. Needs $RUN, and $RUNS/$RUN to exist already.
claim_port() {
  local p=$1 owner
  mkdir -p "$RUNS/.ports"
  while :; do
    if [ -z "$(listener_pid "$p")" ]; then
      if mkdir "$RUNS/.ports/$p" 2>/dev/null; then
        echo "$RUN" > "$RUNS/.ports/$p/run"
        echo "$p"
        return
      fi
      owner=$(cat "$RUNS/.ports/$p/run" 2>/dev/null || true)
      if [ -n "$owner" ] && [ ! -d "$RUNS/$owner" ]; then
        rm -rf "$RUNS/.ports/$p"
        continue
      fi
    fi
    p=$((p + 1))
  done
}

release_ports() {
  local d
  for d in "$RUNS"/.ports/*/; do
    [ "$(cat "$d/run" 2>/dev/null)" = "$RUN" ] && rm -rf "$d"
  done
  return 0
}

# Fingerprint of the platform code: API and worker don't reload, so a change here after launch
# means they run stale code. The frontend hot-reloads and is left out.
platform_fingerprint() {
  { git -C "$ROOT" rev-parse HEAD; git -C "$ROOT" diff HEAD -- dembrane/platform; } | shasum | cut -c1-12
}
