#!/usr/bin/env bash
# Tells people what a deploy to staging or prod carried. Called by .github/workflows/platform.yml
# after a successful deploy; runnable by hand with gh signed in.
#
#   release.sh prs <from> <to>                      merged PRs with a commit in from..to (JSON)
#   release.sh staging-summary <from> <to>             the staging deploy summary (Markdown)
#   release.sh release-notes <tag> [<prev> [<to>]]  the release title, then its notes
#   release.sh announce-staging <sha>                  after a staging deploy: job summary, Slack, PR comments
#   release.sh publish-release <tag>                after a prod deploy: Release, Slack, PR comments, sam
#
# DRY_RUN=1 reads GitHub as usual and prints each post, comment, release and event instead of
# sending it. Nothing here is customer-facing: the in-app release notes are drafted by sam from
# the release.published event and land through a reviewed PR.
#
# The commit staging runs is recorded by GitHub Deployments (the deploy job's `environment: staging`):
# the last deployment whose latest status is success is where the staging summary starts.
set -euo pipefail

REPO=${GITHUB_REPOSITORY:-Dembrane/echo}
SERVER=${GITHUB_SERVER_URL:-https://github.com}
RUN_URL=${GITHUB_RUN_ID:+$SERVER/$REPO/actions/runs/$GITHUB_RUN_ID}
DRY_RUN=${DRY_RUN:-0}
TEAM_CHANNEL=${TEAM_CHANNEL:-C0884QPQF6W} # #team-engineering: releases to prod
STAGING_CHANNEL=${STAGING_CHANNEL:-C0C4HBZNSNT} # #alerts-ci: every staging deploy
STAGING_DASHBOARD_URL=${STAGING_DASHBOARD_URL:-https://dashboard.staging.dembrane.com}
PROD_DASHBOARD_URL=${PROD_DASHBOARD_URL:-https://dashboard.dembrane.com}
SLACK_LINES=${SLACK_LINES:-40}
failed=0

now() { date -u '+%Y-%m-%d %H:%M UTC'; }
warn() { echo "::warning::$*" >&2; failed=1; }
dry() { [ "$DRY_RUN" = 1 ]; }

prs() {
  local from=$1 to=$2
  # Every commit in the range, then the merged PRs each one belongs to. Open PRs that happen
  # to contain a commit (a long-lived branch's PR) are left out.
  gh api "repos/$REPO/compare/$from...$to?per_page=100" --paginate --jq '.commits[].sha' |
    xargs -r -P 8 -I{} gh api "repos/$REPO/commits/{}/pulls" \
      --jq '.[] | select(.merged_at != null) | {number, title, author: .user.login, url: .html_url} | @json' |
    jq -s 'unique_by(.number)'
}

short() { gh api "repos/$REPO/commits/$1" --jq '.sha[0:7]'; }

# One line per PR: markdown for GitHub, mrkdwn for Slack.
md_lines() { jq -r '.[] | "- #\(.number) \(.title) @\(.author)"'; }
slack_lines() {
  jq -r --argjson max "$SLACK_LINES" '
    def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
    (.[:$max][] | "• <\(.url)|#\(.number)> \(.title | esc) (\(.author))"),
    (if length > $max then "and \(length - $max) more in the compare view" else empty end)'
}

staging_summary() {
  local from=$1 to=$2 list=${3:-} a b n
  [ -n "$list" ] || list=$(prs "$from" "$to")
  a=$(short "$from") b=$(short "$to") n=$(jq length <<<"$list")
  echo "### dembrane-staging runs [\`$b\`]($SERVER/$REPO/commit/$to)"
  echo
  if [ "$n" = 0 ]; then
    echo "No merged pull requests since \`$a\`."
  else
    echo "$n pull request$([ "$n" = 1 ] || echo s) since \`$a\` ([compare]($SERVER/$REPO/compare/$from...$to)):"
    echo
    md_lines <<<"$list"
  fi
}

# The release before <tag> by version order, whether or not <tag> exists yet.
previous_tag() {
  { gh api "repos/$REPO/tags?per_page=100" --paginate --jq '.[].name'; echo "$1"; } |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -uV | awk -v t="$1" '$0 == t { print p; exit } { p = $0 }'
}

# An annotated tag's message: its first line is the release headline, the rest its intro.
tag_message() {
  local obj
  obj=$(gh api "repos/$REPO/git/ref/tags/$1" --jq '[.object.type, .object.sha] | @tsv' 2>/dev/null) || return 0
  [ "${obj%%$'\t'*}" = tag ] || return 0
  gh api "repos/$REPO/git/tags/${obj#*$'\t'}" --jq .message
}

# Prints the title on the first line and the notes after it.
release_notes() {
  local tag=$1 prev=${2:-} to=${3:-$1} list=${4:-} msg headline intro
  [ -n "$prev" ] || prev=$(previous_tag "$tag")
  [ -n "$list" ] || list=$(prs "$prev" "$to")
  msg=$(tag_message "$tag")
  headline=$(head -n1 <<<"$msg") intro=$(tail -n +2 <<<"$msg" | sed '/./,$!d')
  [ "$headline" = "$tag" ] && headline=""
  echo "$tag${headline:+: $headline}"
  [ -z "$intro" ] || printf '%s\n\n' "$intro"
  # Conventional prefixes (feat, fix, ...) group the list when at least half the titles have
  # one, the rest going under Other changes; otherwise it is a flat list. Ticket ids in
  # front (ECHO-917) are dropped; a scope stays as "scope: text".
  jq -r '
    def types: {feat: "New features", fix: "Bug fixes", perf: "Performance",
      refactor: "Maintenance", chore: "Maintenance", ci: "Maintenance", build: "Maintenance",
      test: "Maintenance", docs: "Maintenance", style: "Maintenance", revert: "Maintenance"};
    def order: ["New features", "Bug fixes", "Performance", "Maintenance", "Other changes"];
    def item: (.title | sub("^(\\[?[A-Z][A-Z0-9]*-[0-9]+\\]?[ ,:]*)+"; "")) as $t
      | ($t | capture("^(?<type>[A-Za-z]+)(\\((?<scope>[^)]*)\\))?!?:\\s*(?<rest>.+)$")) // null
      | . as $m
      | (if $m != null then types[$m.type | ascii_downcase] else null end) as $g
      | if $g then {group: $g, text: (if $m.scope then "\($m.scope): \($m.rest)" else $m.rest end)}
        else {group: null, text: $t} end;
    def line: "- \(.text) (#\(.number), @\(.author))";
    [.[] | (item + {number, author})] as $items
    | if ($items | length) == 0 then "No merged pull requests since \($prev)."
      elif ([$items[] | select(.group)] | length) * 2 < ($items | length) then ($items[] | line)
      else
        [order[] as $o | [$items[] | select((.group // "Other changes") == $o)]
          | select(length > 0) | "## \($o)\n\(map(line) | join("\n"))"] | join("\n\n")
      end' --arg prev "$prev" <<<"$list"
  echo
  echo "**Full Changelog**: $SERVER/$REPO/compare/$prev...$tag"
}

slack_post() {
  local channel=$1 text=$2
  if dry; then printf '[dry run] Slack %s:\n%s\n\n' "$channel" "$text"; return 0; fi
  [ -n "${SLACK_TOKEN:-}" ] || { warn "SLACK_TOKEN is not set; skipped the Slack post"; return 0; }
  jq -n --arg c "$channel" --arg t "$text" '{channel: $c, text: $t, unfurl_links: false, unfurl_media: false}' |
    curl -sS -X POST https://slack.com/api/chat.postMessage \
      -H "Authorization: Bearer $SLACK_TOKEN" -H 'content-type: application/json; charset=utf-8' --data @- |
    jq -e .ok >/dev/null || warn "Slack post to $channel failed"
}

comment_prs() {
  local list=$1 body=$2 n
  for n in $(jq -r '.[].number' <<<"$list"); do
    if dry; then echo "[dry run] comment on #$n: $body"; continue; fi
    gh api "repos/$REPO/issues/$n/comments" -f body="$body" >/dev/null || warn "comment on #$n failed"
  done
}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && ! dry; then tee -a "$GITHUB_STEP_SUMMARY"; else cat; fi
}

# The commit of the last successful deployment to <env>, and how it was found.
previous_deploy() {
  local env=$1 id sha state
  while read -r id sha; do
    state=$(gh api "repos/$REPO/deployments/$id/statuses?per_page=1" --jq '.[0].state // ""')
    [ "$state" = success ] && { echo "$sha deployment"; return 0; }
  done < <(gh api "repos/$REPO/deployments?environment=$env&per_page=30" --jq '.[] | "\(.id) \(.sha)"')
  echo "$(gh api "repos/$REPO/releases/latest" --jq .tag_name) release"
}

announce_staging() {
  local sha=$1 prev kind list b text
  # STAGING_FROM=<sha> starts the list there instead, as if staging had last been deployed from it.
  if [ -n "${STAGING_FROM:-}" ]; then prev=$STAGING_FROM kind=deployment
  else read -r prev kind < <(previous_deploy staging); fi
  list=$(prs "$prev" "$sha")
  b=$(short "$sha")
  echo "::group::staging summary ($kind $prev..$b)"
  staging_summary "$prev" "$sha" "$list" | summary
  echo "::endgroup::"
  # What changed and where to look at it: the pull requests by title, and the dashboard.
  # Commit ids stay in the job summary.
  text="*Staging updated* · <$STAGING_DASHBOARD_URL|open staging>"
  if [ "$(jq length <<<"$list")" = 0 ]; then text+=$'\n'"No new pull requests."
  else text+=$'\n'"$(slack_lines <<<"$list")"; fi
  slack_post "$STAGING_CHANNEL" "$text"
  # Without an earlier staging deployment the list reaches back to the last release, and those
  # PRs were never told they were on staging: comments start from the second deploy.
  if [ "$kind" = deployment ]; then
    comment_prs "$list" "Now on [staging]($STAGING_DASHBOARD_URL), deployed $(now)."
  else
    echo "::notice::First recorded staging deployment: the list starts at release $prev and no PR comments were posted"
  fi
}

# sam hears about each release the way it hears about account events: a POST signed with
# HMAC-SHA256 over the sorted, compact JSON (X-Webhook-Signature: sha256=<hex>). sam drafts the
# in-app release notes entry, documentation updates and any video from it.
sam_event() {
  local payload=$1 body sig
  if [ -z "${SAM_RELEASE_WEBHOOK_URL:-}" ] || [ -z "${SAM_RELEASE_WEBHOOK_SECRET:-}" ]; then
    echo "::notice::SAM_RELEASE_WEBHOOK_URL or SAM_RELEASE_WEBHOOK_SECRET is not set; sam was not told about this release"
    dry && printf '[dry run] release.published payload:\n%s\n' "$(jq . <<<"$payload")"
    return 0
  fi
  body=$(python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")), end="")' <<<"$payload")
  sig=$(printf '%s' "$body" | python3 -c 'import hashlib,hmac,os,sys; print(hmac.new(os.environ["SAM_RELEASE_WEBHOOK_SECRET"].encode(), sys.stdin.buffer.read(), hashlib.sha256).hexdigest())')
  if dry; then printf '[dry run] POST release.published (signature sha256=%s...) with:\n%s\n' "${sig:0:8}" "$(jq . <<<"$body")"; return 0; fi
  printf '%s' "$body" | curl -sS --fail-with-body --retry 3 --max-time 20 -X POST "$SAM_RELEASE_WEBHOOK_URL" \
    -H 'Content-Type: application/json' -H 'User-Agent: Dembrane-Webhook/1.0' \
    -H 'X-Webhook-Event: release.published' -H "X-Webhook-Signature: sha256=$sig" --data-binary @- >/dev/null ||
    warn "sending release.published to sam failed"
}

publish_release() {
  local tag=$1 sha prev list notes title url n text
  sha=$(gh api "repos/$REPO/commits/$tag" --jq .sha)
  prev=${PREV_TAG:-$(previous_tag "$tag")}
  list=$(prs "$prev" "$tag")
  notes=$(release_notes "$tag" "$prev" "$tag" "$list")
  title=$(head -n1 <<<"$notes") notes=$(tail -n +2 <<<"$notes")
  url=$SERVER/$REPO/releases/tag/$tag
  printf '## %s\n\n%s\n' "$title" "$notes" | summary
  if gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    echo "::notice::Release $tag already exists; left its notes as they are"
  elif dry; then
    echo "[dry run] gh release create $tag --title \"$title\""
  else
    gh release create "$tag" -R "$REPO" --verify-tag --title "$title" --notes "$notes" >/dev/null ||
      warn "creating the $tag release failed"
  fi
  n=$(jq length <<<"$list")
  text="*$title* is live on prod · $n pull request$([ "$n" = 1 ] || echo s) since $prev · <$url|release notes> · <$PROD_DASHBOARD_URL|open the dashboard>"
  [ "$n" = 0 ] || text+=$'\n'"$(slack_lines <<<"$list")"
  slack_post "$TEAM_CHANNEL" "$text"
  comment_prs "$list" "Released in [$tag]($url)."
  sam_event "$(jq -n --arg tag "$tag" --arg title "$title" --arg url "$url" --arg sha "$sha" \
    --arg prev "$prev" --arg notes "$notes" --arg repo "$REPO" --argjson prs "$list" \
    --arg id "$(python3 -c 'import uuid; print(uuid.uuid4())')" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '
    {event: "release.published", id: $id, timestamp: $ts,
     release: {repository: $repo, tag: $tag, name: $title, url: $url, sha: $sha, previous_tag: $prev,
               notes: $notes, pull_requests: $prs}}')"
}

case "${1:-}" in
  prs) prs "$2" "$3" ;;
  staging-summary) staging_summary "$2" "$3" ;;
  release-notes) release_notes "$2" "${3:-}" "${4:-}" ;;
  announce-staging) announce_staging "$2" ;;
  publish-release) publish_release "$2" ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
exit "$failed"
