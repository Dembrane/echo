#!/usr/bin/env bash
# Sends the messages slack.jq draws; sourced by ci-notify.sh and release.sh.
#
#   slack_send <channel> <message> [<thread>] [<ts>]
#
# Posts <message> ({text, blocks}) to the channel, as a reply when given a thread. With <ts> it
# edits that message in place instead, and posts it again when Slack cannot edit it. slack_ts
# is the message's timestamp afterwards, empty when nothing was sent: a post Slack refuses is a
# warning, never a failed deploy. DRY_RUN=1 prints the call instead; TEST=1 marks the text as a
# test.
slack_ts=""

slack_call() {
  curl -sS -X POST "https://slack.com/api/$1" -H "Authorization: Bearer $SLACK_TOKEN" \
    -H 'content-type: application/json; charset=utf-8' --data @- <<<"$2" || echo '{}'
}

slack_send() {
  local channel=$1 thread=${3:-} ts=${4:-} payload res
  slack_ts=""
  [ -n "$2" ] || { echo "::warning::no Slack message to send" >&2; return 0; }
  payload=$(jq --arg c "$channel" --arg th "$thread" --arg test "${TEST:+[TEST, please ignore] }" '
    {channel: $c, text: ($test + .text)} + (if .blocks then {blocks} else {} end)
    + {unfurl_links: false, unfurl_media: false} + (if $th != "" then {thread_ts: $th} else {} end)' <<<"$2")
  if [ "${DRY_RUN:-0}" = 1 ]; then
    if [ -n "$ts" ]; then printf '[dry run] Slack chat.update %s, message %s:\n%s\n\n' "$channel" "$ts" "$(jq --arg ts "$ts" '. + {ts: $ts}' <<<"$payload")"
    else printf '[dry run] Slack chat.postMessage %s%s:\n%s\n\n' "$channel" "${thread:+, reply in thread $thread}" "$payload"; fi
    slack_ts=${ts:-0000000000.000000}
    return 0
  fi
  [ -n "${SLACK_TOKEN:-}" ] || { echo "::warning::SLACK_TOKEN is not set; skipped the Slack post" >&2; return 0; }
  if [ -n "$ts" ]; then
    res=$(slack_call chat.update "$(jq --arg ts "$ts" '. + {ts: $ts}' <<<"$payload")")
    if [ "$(jq -r '.ok' <<<"$res" 2>/dev/null)" = true ]; then slack_ts=$ts; return 0; fi
    echo "::notice::Slack could not edit message $ts ($(jq -r '.error // "no answer"' <<<"$res" 2>/dev/null)); posting it again" >&2
  fi
  res=$(slack_call chat.postMessage "$payload")
  slack_ts=$(jq -r 'if .ok == true then .ts else "" end' <<<"$res" 2>/dev/null) || slack_ts=""
  [ -n "$slack_ts" ] || echo "::warning::Slack post failed: $(jq -r '.error // "no answer"' <<<"$res" 2>/dev/null)" >&2
}
