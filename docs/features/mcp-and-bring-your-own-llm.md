---
title: MCP & bring-your-own-LLM
description: Connect an assistant such as Claude or ChatGPT to your dembrane conversations through MCP. How to connect, what you consent to, the organisation switch, and what the tools can do.
audience: all
---

# MCP & bring-your-own-LLM

MCP is a bridge that lets an assistant such as Claude, ChatGPT or Le Chat read your
dembrane conversations and projects. The assistant acts as you: it can see what you can
already see, in the organisations you allow, and nothing more. In the product this is
"Connect your agent" (Beta).

It works on every plan. A free organisation gets 1,000 tool calls per calendar month. An
organisation with at least one paid workspace is not counted.

> [!WARNING]
> The assistant you connect, and the company that runs it, receive the conversations and
> projects you allow. dembrane is not responsible for what they do with that data. You can
> revoke a connection at any time.

## First: the organisation switch

MCP access is off for every organisation until an organisation admin or owner turns it on.

1. Open the organisation's settings and choose "MCP access".
2. Turn the switch on, and confirm with "Turn on".

From then on, members of the organisation can connect assistants to what they can already
see there. Turning the switch off stops every connected agent in the organisation at once.
Members keep their connections, and these work again if you turn it back on.

The same page shows two lists for the organisation: "Connected agents", every member's
connection that names the organisation, and "Activity", every call an agent made, newest
first. An admin can revoke any connection in the first list.

## Connect an assistant

1. Open "Connect your agent" and copy the "MCP URL". Organisation admins and owners find the
   page through the link on "MCP access". Anyone signed in can open it at
   `https://dashboard.dembrane.com/connect-agent`. The first time, you confirm a notice
   titled "Your data will leave dembrane".
2. Paste the address into your assistant where it asks for an MCP server.
3. The assistant opens dembrane in your browser and asks your permission. Sign in if asked.
4. On the consent screen, check what it asks for. It always asks to "read conversations,
   transcripts, projects and settings you can see". "Also allow it to change project
   settings" is off unless you tick it.
5. Under "In which organisations", tick the organisations it can read. One where the switch
   is off cannot be ticked.
6. Choose "Access expires after": 30, 90 or 365 days. 90 is the default.
7. Tick the box that says you understand the assistant and its provider will receive this
   data, then choose "Allow". "Deny" sends you back without giving access.

"Your organisations" on the same page shows where MCP access is on. If yours is off and you
are not an admin, it says "Ask your admin".

## End a connection

Open "Connect your agent". Under "Connected agents", choose "Revoke" next to the
connection. The assistant loses access immediately. A connection also ends by itself when
it expires.

## What the assistant can do

These are the tools an assistant gets. Their names show up in your assistant and in the
"Activity" list.

| Tool | What it does |
|---|---|
| `dembrane_whoami` | Says who the assistant acts as, and which organisations and workspaces it can reach |
| `dembrane_list_tools` | Lists every tool with a one-line description |
| `dembrane_find_projects` | Finds projects by name across the workspaces it can reach |
| `dembrane_get_project` | Reads one project's settings |
| `dembrane_update_project` | Changes project settings. Only if you allowed changes and you may edit the project yourself |
| `dembrane_list_project_webhooks` | Lists a project's webhooks, never the secret. Only if you may manage webhooks |
| `dembrane_list_conversations` | Lists a project's conversations, without transcripts |
| `dembrane_get_conversation` | Reads one conversation's details: participant, title, summary, tags, status and duration |
| `dembrane_search_transcripts` | Finds the conversations in a project whose transcript contains your words, with short snippets |
| `dembrane_grep_conversation` | Finds passages around your words in one conversation's transcript |
| `dembrane_read_transcript` | Reads one conversation's transcript, a page at a time |
| `dembrane_search_docs` | Searches the dembrane documentation |
| `dembrane_read_doc` | Reads one page of the dembrane documentation |
| `dembrane_report_issue` | Files a support ticket in your name |
| `dembrane_request_tool` | Asks the dembrane team for a tool that does not exist yet |

The free plan does not hide transcripts. Every tool returns the same text on every plan.

## Bring your own language model

Bringing your own language model provider for dembrane's own features (transcription,
summaries, chat and reports) is not possible through configuration in this version.

MCP works the other way round: your assistant brings its own model and reads dembrane
through the tools above.

## For developers

The address pattern, the sign-in flow, token lifetimes and limits are on
[MCP for developers](../users/developer-external/mcp-and-byo-llm.md).

## Related

- [MCP for developers](../users/developer-external/mcp-and-byo-llm.md): the technical
  detail.
- [Webhooks and integrations](./webhooks-and-integrations.md): have dembrane send data to
  your system instead.
- [Export and data portability](./export-and-data-portability.md): downloads.
- [Organisations and workspaces](./organisations-and-workspaces.md): who is an organisation
  admin.
- [Tiers and billing](./tiers-and-billing.md): what the free plan includes.
