#!/usr/bin/env bash
# The messages .github/workflows/platform.yml leaves on PRs and in Slack; runnable by hand with
# gh signed in.
#
#   ci-notify.sh preview starting <pr>            a first deploy begins: "PR preview environment being created"
#   ci-notify.sh preview deployed <pr>            the PR's preview comment and "... created"
#   ci-notify.sh preview failed <pr> <what>       ... the step that failed, and "... not created" or "not updated"
#   ci-notify.sh preview removed <pr> [<why>]     ... the preview is gone (never creates a comment)
#   ci-notify.sh failure                          what stopped this run, to #alerts-ci
#
# One preview comment per PR, found by a hidden marker and edited in place, so a PR with many
# pushes carries one current comment instead of a trail. #alerts-ci likewise gets one message
# per preview, edited in place to show its current state (being created, created with its
# links, not created, removed), with the PR title and author. Each thing that happens to the
# preview is also a short reply in that message's thread, which is its history. The comment
# remembers the message in a second hidden marker. DRY_RUN=1 prints instead of posting; TEST=1
# marks a Slack message as a test.
set -euo pipefail

REPO=${GITHUB_REPOSITORY:-Dembrane/echo}
SERVER=${GITHUB_SERVER_URL:-https://github.com}
RUN_URL=${GITHUB_RUN_ID:+$SERVER/$REPO/actions/runs/$GITHUB_RUN_ID}
DRY_RUN=${DRY_RUN:-0}
MARKER='<!-- dembrane-pr-preview -->'
# Followed by the Slack channel and timestamp of the preview's message in #alerts-ci.
THREAD_MARKER='dembrane-pr-preview-slack'
# Only the workflow's own comment is edited, never a person's that quotes the marker.
COMMENT_AUTHOR=${COMMENT_AUTHOR:-github-actions[bot]}
ALERTS_CHANNEL=${ALERTS_CHANNEL:-C0C4HBZNSNT} # #alerts-ci
PREVIEW_DOMAIN=${PREVIEW_DOMAIN:-preview.dembrane.com}
LIB=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=.github/scripts/slack.sh
. "$LIB/slack.sh"

now() { date -u '+%Y-%m-%d %H:%M UTC'; }

# <live> says whether a deploy of this PR is being served: only then are its links shown.
preview_body() {
  local state=$1 pr=$2 what=${3:-} live=${4:-} head=${HEAD_SHA:-} commit="" links run=""
  [ -z "$head" ] || commit="[\`${head:0:7}\`]($SERVER/$REPO/pull/$pr/commits/$head)${BASE_REF:+, merged with \`$BASE_REF\`}"
  [ -z "$RUN_URL" ] || run="[Run]($RUN_URL)"
  links="| | |
|---|---|
| Dashboard | https://dashboard-$pr.$PREVIEW_DOMAIN |
| Portal | https://portal-$pr.$PREVIEW_DOMAIN |
| API | https://api-$pr.$PREVIEW_DOMAIN |
| Admin login | \`sameer+admin@dembrane.com\`, password in Secret Manager as \`preview-admin-password\` (dembrane-web-previews) |"
  echo "$MARKER"
  case "$state" in
    starting)
      echo "**Preview is being deployed** for $commit, $(now). ${run}"
      ;;
    deployed)
      echo "**Preview is up** for $commit, $(now). ${run}"
      echo
      echo "$links"
      echo
      echo "<sub>Updated on every push while the PR has the preview label.</sub>"
      ;;
    failed)
      echo "**Preview deploy failed** at **$what** for $commit, $(now). ${run}"
      echo
      if [ -n "$live" ]; then
        echo "The links below serve the last deploy that succeeded."
        echo
        echo "$links"
      else
        echo "Nothing is deployed."
      fi
      ;;
    removed)
      echo "**Preview removed** $(now)${what:+, $what}. Add the preview label to deploy it again."
      ;;
  esac
}

message() { jq -c -L "$LIB" "include \"slack\"; $1" "${@:2}"; }

# Reads the workflow's preview comment on a PR into id, thread (the Slack message it
# remembers) and live (set when the comment shows the links of a deploy being served).
preview_read() {
  local old=""
  id=$(gh api "repos/$REPO/issues/$1/comments?per_page=100" --paginate \
    --jq ".[] | select(.user.login == \"$COMMENT_AUTHOR\" and (.body | contains(\"$MARKER\"))) | .id" | head -n1)
  [ -z "$id" ] || old=$(gh api "repos/$REPO/issues/comments/$id" --jq .body)
  thread=$(sed -nE "s/.*<!-- $THREAD_MARKER $ALERTS_CHANNEL ([0-9]+\.[0-9]+) -->.*/\1/p" <<<"$old" | head -n1)
  live=""
  ! grep -q '^| Dashboard |' <<<"$old" || live=1
}

# A PR as the one-item list slack.jq draws: title, author, link and description.
pr_json() { gh api "repos/$REPO/pulls/$1" --jq '[{number, title, author: .user.login, url: .html_url, body}]'; }

# This run's failed jobs and the step each failed at. NEEDS (the workflow's toJSON(needs)) is
# the fallback when the jobs API cannot be read.
failed_jobs() {
  local needs=${NEEDS:-'{}'} jobs
  if [ -n "${GITHUB_RUN_ID:-}" ] && jobs=$(gh api "repos/$REPO/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100" \
    --jq '[.jobs[] | select(.conclusion == "failure")
      | {name, step: ([.steps[]? | select(.conclusion == "failure") | .name][0] // "")}
      | select(.step != "Stop when a check failed")]' 2>/dev/null); then echo "$jobs"
  else jq -c '[to_entries[] | select(.value.result == "failure") | {name: .key, step: ""}]' <<<"$needs"; fi
}

# Tells #alerts-ci about a preview, given what preview_read found. The preview's own message
# is edited to its new state, or posted when there is none yet, leaving thread as the message
# to remember; the event is also a reply under it, unless the message was posted just now.
preview_slack() {
  local state=$1 pr=$2 what=${3:-} was=$thread sha=${HEAD_SHA:-} list jobs why top="" reply=""
  sha=${sha:+\`${sha:0:7}\`}
  list=$(pr_json "$pr")
  case "$state" in
    starting)
      top=$(message 'starting("PR preview environment being created"; $run; 1)' --arg run "$RUN_URL" <<<"$list")
      ;;
    deployed)
      top=$(message 'environment(":seedling:"; "PR preview environment created"; $url; 1)' \
        --arg url "https://dashboard-$pr.$PREVIEW_DOMAIN"$'\n'"https://portal-$pr.$PREVIEW_DOMAIN" <<<"$list")
      if [ -n "$live" ]; then reply=$(message 'reply(":arrows_counterclockwise:"; "PR preview environment updated"; $sha; $run)' -n --arg sha "$sha" --arg run "$RUN_URL")
      else reply=$(message 'reply(":seedling:"; "PR preview environment created"; $sha; $run)' -n --arg sha "$sha" --arg run "$RUN_URL"); fi
      ;;
    failed)
      # A failed check is named by its job; with none, the deploy itself stopped at <what>.
      jobs=$(failed_jobs)
      [ "$(jq length <<<"$jobs")" != 0 ] || jobs=$(jq -Rc '[scan("[0-9]{2}-[a-z-]+") | {name: ., step: ""}]' <<<"$what")
      [ "$(jq length <<<"$jobs")" != 0 ] || jobs=$(jq -nc --arg s "$what" '[{name: "deploy-pr", step: $s}]')
      why=$([ -n "$live" ] && echo updated || echo created)
      # A preview that is up stays up, and so does its message: only the thread hears of it.
      [ -n "$live" ] && [ -n "$was" ] ||
        top=$(message 'stopped("PR preview environment not \($why)"; ($jobs | reasons) + ", so the preview was not \($why)."; $run; 1)' \
          --arg why "$why" --argjson jobs "$jobs" --arg run "$RUN_URL" <<<"$list")
      reply=$(message 'reply(":warning:"; "PR preview environment not \($why)"; ($jobs | reasons) + "."; $run)' -n \
        --arg why "$why" --argjson jobs "$jobs" --arg run "$RUN_URL")
      ;;
    removed)
      top=$(message 'environment(":wastebasket:"; "PR preview environment removed"; $why; 1)' --arg why "${what:+${what^}.}" <<<"$list")
      reply=$(message 'reply(":wastebasket:"; "PR preview environment removed"; $why; $run)' -n --arg why "${what:+${what^}.}" --arg run "$RUN_URL")
      ;;
  esac
  if [ -n "$top" ]; then
    slack_send "$ALERTS_CHANNEL" "$top" "" "$was"
    thread=${slack_ts:-$was}
  fi
  [ -z "$reply" ] || [ -z "$was" ] || [ "$thread" != "$was" ] || slack_send "$ALERTS_CHANNEL" "$reply" "$was"
}

preview() {
  local state=$1 pr=$2 what=${3:-} body id thread live
  [[ $pr =~ ^[0-9]+$ ]] || { echo "bad PR number: $pr" >&2; exit 2; }
  preview_read "$pr"
  # Only a first deploy is announced when it begins; a redeploy speaks when it is done.
  [ "$state" != starting ] || [ -z "$live" ] || return 0
  # A preview without a comment was never announced, so its removal is not either.
  if [ -n "$id" ] || [ "$state" != removed ]; then
    preview_slack "$state" "$pr" "$what" || echo "::warning::could not tell Slack about the preview" >&2
  fi
  body=$(preview_body "$state" "$pr" "$what" "$live")
  [ -z "$thread" ] || body+=$'\n'"<!-- $THREAD_MARKER $ALERTS_CHANNEL $thread -->"
  if [ "$DRY_RUN" = 1 ]; then
    local act=create
    [ -n "$id" ] && act="edit $id"
    [ -z "$id" ] && [ "$state" = removed ] && act="skip (no comment to edit)"
    printf '[dry run] %s comment on #%s:\n%s\n' "$act" "$pr" "$body"
  elif [ -n "$id" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$id" -f body="$body" --jq .html_url
  elif [ "$state" != removed ]; then
    gh api "repos/$REPO/issues/$pr/comments" -f body="$body" --jq .html_url
  fi
}

# Says which environment was not updated and what stopped it, with the run's link, when the
# job that deploys it never got to say so itself. DEPLOY_ENV (staging, echo-next or prod) or PR names the
# environment; TEARDOWN=true is a preview that was not removed. A PR preview's failure goes to
# the message its comment remembers.
failure() {
  local env=${DEPLOY_ENV:-} pr=${PR:-} head so="" jobs list='[]' id thread="" live=""
  jobs=$(failed_jobs)
  case "$env" in
    staging) head="Staging environment not updated" so=", so staging was not updated" ;;
    prod) head="Production environment not updated" so=", so production was not updated" ;;
    echo-next) head="echo-next environment not updated" so=", so echo-next was not updated" ;;
    *)
      if [[ $pr =~ ^[0-9]+$ ]]; then
        preview_read "$pr" 2>/dev/null || true
        if [ "${TEARDOWN:-}" != true ]; then
          preview_slack failed "$pr" ""
          [ -n "$slack_ts" ]
          return
        fi
        head="PR preview environment not removed" so=", so the preview was not removed"
        [ -n "$thread" ] || list=$(pr_json "$pr" 2>/dev/null) || list='[]'
      else
        head="Checks failed on ${GITHUB_REF_NAME:-?}"
      fi
      ;;
  esac
  if [ -n "$thread" ]; then
    slack_send "$ALERTS_CHANNEL" "$(message 'reply(":warning:"; $head; ($jobs | reasons) + "."; $run)' -n \
      --arg head "$head" --argjson jobs "$jobs" --arg run "$RUN_URL")" "$thread"
  else
    slack_send "$ALERTS_CHANNEL" "$(message 'stopped($head; ($jobs | reasons) + $so + "."; $run; 1)' \
      --arg head "$head" --arg so "$so" --argjson jobs "$jobs" --arg run "$RUN_URL" <<<"$list")"
  fi
  [ -n "$slack_ts" ]
}

case "${1:-}" in
  preview) preview "$2" "$3" "${4:-}" ;;
  failure) failure ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
