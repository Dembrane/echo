#!/usr/bin/env bash
# The messages .github/workflows/platform.yml leaves on PRs and in Slack; runnable by hand with
# gh signed in.
#
#   ci-notify.sh preview deployed <pr>            the PR's preview comment: links and admin login
#   ci-notify.sh preview failed <pr> <what>       ... the step that failed, with the run link
#   ci-notify.sh preview removed <pr> [<why>]     ... the preview is gone (never creates a comment)
#   ci-notify.sh failure                          this run's failed jobs and steps to #alerts-ci
#
# One preview comment per PR, found by a hidden marker and edited in place, so a PR with many
# pushes carries one current comment instead of a trail. DRY_RUN=1 prints instead of posting;
# TEST=1 marks a Slack message as a test.
set -euo pipefail

REPO=${GITHUB_REPOSITORY:-Dembrane/echo}
SERVER=${GITHUB_SERVER_URL:-https://github.com}
RUN_URL=${GITHUB_RUN_ID:+$SERVER/$REPO/actions/runs/$GITHUB_RUN_ID}
DRY_RUN=${DRY_RUN:-0}
MARKER='<!-- dembrane-pr-preview -->'
# Only the workflow's own comment is edited, never a person's that quotes the marker.
COMMENT_AUTHOR=${COMMENT_AUTHOR:-github-actions[bot]}
ALERTS_CHANNEL=${ALERTS_CHANNEL:-C0C4HBZNSNT} # #alerts-ci
PREVIEW_DOMAIN=${PREVIEW_DOMAIN:-preview.dembrane.com}

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
      echo "<sub>Updated on every push while the PR has the preview label. Seeded with the Millbrook sample and the accounts demo.</sub>"
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

preview() {
  local state=$1 pr=$2 what=${3:-} body id
  [[ $pr =~ ^[0-9]+$ ]] || { echo "bad PR number: $pr" >&2; exit 2; }
  body=$(preview_body "$state" "$pr" "$what")
  id=$(gh api "repos/$REPO/issues/$pr/comments?per_page=100" --paginate \
    --jq ".[] | select(.user.login == \"$COMMENT_AUTHOR\" and (.body | contains(\"$MARKER\"))) | .id" | head -n1)
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

# Names each failed job and the step it failed at, linking the job's log. NEEDS (the
# workflow's toJSON(needs)) is the fallback when the jobs API cannot be read.
failure() {
  local jobs text what=${WHAT:-platform run} sha=${SHA:-${GITHUB_SHA:-}} needs=${NEEDS:-'{}'}
  jobs=$(gh api "repos/$REPO/actions/runs/${GITHUB_RUN_ID:?}/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100" \
    --jq '[.jobs[] | select(.conclusion == "failure")
      | {name, url: .html_url, step: ([.steps[]? | select(.conclusion == "failure") | .name][0] // "")}
      | select(.step != "Stop when a check failed")]' 2>/dev/null) ||
    jobs=$(jq -c '[to_entries[] | select(.value.result == "failure") | {name: .key, url: "", step: ""}]' <<<"$needs")
  text="${TEST:+[TEST, please ignore] }:x: *platform* · $what failed on \`${GITHUB_REF_NAME:-?}\` (${sha:0:7})"
  text+=$(jq -r '.[] | "\n• *\(.name)*" + (if .step != "" then " at \(.step)" else "" end) + (if .url != "" then " · <\(.url)|log>" else "" end)' <<<"$jobs")
  [ -z "$RUN_URL" ] || text+=$'\n'"<$RUN_URL|run>"
  if [ "$DRY_RUN" = 1 ]; then printf '[dry run] Slack %s:\n%s\n' "$ALERTS_CHANNEL" "$text"; return 0; fi
  jq -n --arg c "$ALERTS_CHANNEL" --arg t "$text" '{channel: $c, text: $t, unfurl_links: false}' |
    curl -sS -X POST https://slack.com/api/chat.postMessage \
      -H "Authorization: Bearer ${SLACK_TOKEN:?}" -H 'content-type: application/json; charset=utf-8' --data @- |
    jq -e .ok >/dev/null
}

case "${1:-}" in
  preview) preview "$2" "$3" "${4:-}" ;;
  failure) failure ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
