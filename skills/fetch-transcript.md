---
name: fetch-transcript
description: Read a conversation's transcript from dembrane, for example the latest retrospective in the "Product meetings" project. Uses the dembrane MCP server or its REST face, acting as the person who connected it.
---

# Fetch a transcript

The agent reads as the person who connected it and sees exactly what they see. Staff API keys do not read project data: staff reach a customer project only through a support session.

## Through MCP (preferred)

1. `dembrane_whoami`: who you are acting as, and which organisations and workspaces you reach.
2. `dembrane_find_projects` with part of the name (`query: "Product meetings"`): take `project_id`.
3. `dembrane_list_conversations` with `project_id`, `search: "retro"`, `sort: "-created_at"`, `limit: 5`: take the conversation `id`. It returns metadata, never transcript text.
4. `dembrane_read_transcript` with `conversation_id`, `offset: 0`, `limit: 200`. Page with `offset` while `has_more` is true, then join the chunks' `transcript` in the order given.

To find where something was said: `dembrane_search_transcripts` over a project, or `dembrane_grep_conversation` in one conversation. `transcript_locked: true` means the workspace's plan cap, not an error.

## Through REST

The same tools at `/api/v2/agent`, with the connector's access token (`dbr_at_...`, one hour; refresh with `curl -s -X POST $API/api/mcp/token -d grant_type=refresh_token -d refresh_token=$REFRESH -d client_id=$CLIENT_ID`):

```sh
API=https://api.dembrane.com
A=(-H "Authorization: Bearer $DEMBRANE_AGENT_TOKEN")
P=$(curl -sf "${A[@]}" "$API/api/v2/agent/projects/find?query=Product%20meetings" | jq -r '.projects[0].id')
C=$(curl -sf "${A[@]}" "$API/api/v2/agent/projects/$P/conversations?search=retro&limit=5" | jq -r '.conversations[0].id')
off=0; : > transcript.txt
while :; do
  page=$(curl -sf "${A[@]}" "$API/api/v2/agent/conversations/$C/transcript?offset=$off&limit=200")
  echo "$page" | jq -r '.chunks[].transcript // empty' >> transcript.txt
  [ "$(echo "$page" | jq -r .has_more)" = true ] || break
  off=$((off + 200))
done
```
