#!/usr/bin/env bash
# The messages .github/workflows/platform.yml leaves on PRs and in Slack; runnable by hand with
# gh signed in.
#
#   ci-notify.sh preview deployed <pr>            the PR's preview comment and "PR preview environment created"
#   ci-notify.sh preview failed <pr> <what>       ... the step that failed, and "... not updated"
#   ci-notify.sh preview removed <pr> [<why>]     ... the preview is gone (never creates a comment)
#   ci-notify.sh failure                          what stopped this run, to #alerts-ci
#
# One preview comment per PR, found by a hidden marker and edited in place, so a PR with many
# pushes carries one current comment instead of a trail. #alerts-ci gets one message per preview,
# with its links, the PR title and author; everything that happens to that preview afterwards is
# a reply in that message's thread. The comment remembers the message in a second hidden marker.
# DRY_RUN=1 prints instead of posting; TEST=1 marks a Slack message as a test.
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

now() { date -u '+%Y-%m-%d %H:%M UTC'; }

preview_body() {
  local state=$1 pr=$2 what=${3:-} head=${HEAD_SHA:-} commit="" links run=""
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
      echo "The links below serve the last deploy that succeeded, if there was one."
      echo
      echo "$links"
      ;;
    removed)
      echo "**Preview removed** $(now)${what:+, $what}. Add the preview label to deploy it again."
      ;;
  esac
}

# Posts a payload built by slack.jq to #alerts-ci, as a reply when given a thread, and leaves
# the new message's timestamp in slack_ts. A post Slack refuses is a warning and an empty
# slack_ts: the deploy stands.
slack_ts=""
slack() {
  local thread=${2:-} payload res
  slack_ts=""
  payload=$(jq --arg c "$ALERTS_CHANNEL" --arg th "$thread" --arg test "${TEST:+[TEST, please ignore] }" '
    {channel: $c, text: ($test + .text), blocks, unfurl_links: false, unfurl_media: false}
    + (if $th != "" then {thread_ts: $th} else {} end)' <<<"$1")
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry run] Slack %s%s:\n%s\n\n' "$ALERTS_CHANNEL" "${thread:+, reply in thread $thread}" "$payload"
    slack_ts=0000000000.000000
    return 0
  fi
  [ -n "${SLACK_TOKEN:-}" ] || { echo "::warning::SLACK_TOKEN is not set; skipped the Slack post" >&2; return 0; }
  res=$(curl -sS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_TOKEN" -H 'content-type: application/json; charset=utf-8' --data @- <<<"$payload") || res='{}'
  slack_ts=$(jq -r 'if .ok == true then .ts else "" end' <<<"$res" 2>/dev/null) || slack_ts=""
  [ -n "$slack_ts" ] || echo "::warning::Slack post failed: $(jq -r '.error // "no answer"' <<<"$res" 2>/dev/null)" >&2
}
message() { jq -c -L "$LIB" "include \"slack\"; $1" "${@:2}"; }

# The workflow's preview comment on a PR: its id, and the Slack thread it remembers.
preview_comment() {
  gh api "repos/$REPO/issues/$1/comments?per_page=100" --paginate \
    --jq ".[] | select(.user.login == \"$COMMENT_AUTHOR\" and (.body | contains(\"$MARKER\"))) | .id" | head -n1
}
preview_thread() {
  [ -n "$1" ] || return 0
  gh api "repos/$REPO/issues/comments/$1" --jq .body |
    sed -nE "s/.*<!-- $THREAD_MARKER $ALERTS_CHANNEL ([0-9]+\.[0-9]+) -->.*/\1/p" | head -n1
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

# The first event of a preview is a message of its own, carrying the PR; later ones are short
# replies in its thread.
preview_slack() {
  local state=$1 pr=$2 what=${3:-} id=$4 thread=$5 head=${HEAD_SHA:-} dash portal jobs why
  dash=https://dashboard-$pr.$PREVIEW_DOMAIN portal=https://portal-$pr.$PREVIEW_DOMAIN
  case "$state" in
    deployed)
      if [ -n "$thread" ]; then
        message 'reply(":arrows_counterclockwise:"; "PR preview environment updated"; $d; $run)' -n \
          --arg d "${head:+\`${head:0:7}\`}" --arg run "$RUN_URL"
      else
        pr_json "$pr" | message 'environment(":seedling:"; "PR preview environment created"; $url; 1)' --arg url "$dash"$'\n'"$portal"
      fi
      ;;
    failed)
      # A failed check is named by its job; with none, the deploy itself stopped at <what>.
      jobs=$(failed_jobs)
      [ "$(jq length <<<"$jobs")" != 0 ] || jobs=$(jq -Rc '[scan("[0-9]{2}-[a-z-]+") | {name: ., step: ""}]' <<<"$what")
      [ "$(jq length <<<"$jobs")" != 0 ] || jobs=$(jq -nc --arg s "$what" '[{name: "deploy-pr", step: $s}]')
      if [ -n "$thread" ]; then
        message 'reply(":warning:"; "PR preview environment not updated"; ($jobs | reasons) + "."; $run)' -n \
          --argjson jobs "$jobs" --arg run "$RUN_URL"
      else
        why=$([ -n "$id" ] && echo updated || echo created)
        pr_json "$pr" | message 'stopped("PR preview environment not \($why)"; ($jobs | reasons) + ", so the preview was not \($why)."; $run)' \
          --arg why "$why" --argjson jobs "$jobs" --arg run "$RUN_URL"
      fi
      ;;
    removed)
      if [ -n "$thread" ]; then
        message 'reply(":wastebasket:"; "PR preview environment removed"; $why; $run)' -n \
          --arg why "${what:+${what^}.}" --arg run "$RUN_URL"
      else
        pr_json "$pr" | message 'environment(":wastebasket:"; "PR preview environment removed"; $why; 1)' --arg why "${what:+${what^}.}"
      fi
      ;;
  esac
}

preview() {
  local state=$1 pr=$2 what=${3:-} body id thread msg
  [[ $pr =~ ^[0-9]+$ ]] || { echo "bad PR number: $pr" >&2; exit 2; }
  id=$(preview_comment "$pr")
  thread=$(preview_thread "$id")
  # A preview without a comment was never announced, so its removal is not either.
  if [ -n "$id" ] || [ "$state" != removed ]; then
    if msg=$(preview_slack "$state" "$pr" "$what" "$id" "$thread"); then slack "$msg" "$thread"
    else echo "::warning::could not build the Slack message" >&2; fi
    thread=${thread:-$slack_ts}
  fi
  body=$(preview_body "$state" "$pr" "$what")
  # A removed preview ends its thread: deploying the PR again is announced as a new environment.
  [ "$state" = removed ] || [ -z "$thread" ] || body+=$'\n'"<!-- $THREAD_MARKER $ALERTS_CHANNEL $thread -->"
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

# Says which environment was not updated and what stopped it, with the run's link. DEPLOY_ENV
# (staging or prod) or PR names the environment; TEARDOWN=true is a preview that was not
# removed. A PR preview's failure is a reply in its thread when its comment remembers one.
failure() {
  local env=${DEPLOY_ENV:-} pr=${PR:-} head so="" thread="" jobs list='[]' msg
  jobs=$(failed_jobs)
  case "$env" in
    staging) head="Staging environment not updated" so=", so staging was not updated" ;;
    prod) head="Production environment not updated" so=", so production was not updated" ;;
    *)
      if [[ $pr =~ ^[0-9]+$ ]]; then
        so=$([ "${TEARDOWN:-}" = true ] && echo removed || echo updated)
        head="PR preview environment not $so" so=", so the preview was not $so"
        thread=$(preview_thread "$(preview_comment "$pr")" 2>/dev/null) || thread=""
        [ -n "$thread" ] || list=$(pr_json "$pr" 2>/dev/null) || list='[]'
      else
        head="Checks failed on ${GITHUB_REF_NAME:-?}"
      fi
      ;;
  esac
  if [ -n "$thread" ]; then
    msg=$(message 'reply(":warning:"; $head; ($jobs | reasons) + "."; $run)' -n \
      --arg head "$head" --argjson jobs "$jobs" --arg run "$RUN_URL")
  else
    msg=$(message 'stopped($head; ($jobs | reasons) + $so + "."; $run)' \
      --arg head "$head" --arg so "$so" --argjson jobs "$jobs" --arg run "$RUN_URL" <<<"$list")
  fi
  slack "$msg" "$thread"
  [ -n "$slack_ts" ]
}

case "${1:-}" in
  preview) preview "$2" "$3" "${4:-}" ;;
  failure) failure ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
