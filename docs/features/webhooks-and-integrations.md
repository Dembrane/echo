---
title: Webhooks & integrations
description: Project webhooks, called Automation in the product. Who can use them, the plan they need, the four events, and how to add and test one.
audience: all
---

# Webhooks & integrations

A webhook sends a message to a web address of yours when something happens in a project,
for example when a conversation has been summarised. Your own system, or a tool such as
Zapier or Make, receives the message and acts on it. In the product the page is called
"Automation" (Beta).

## Who can use it

- "Automation" is in the project sidebar for workspace admins and owners only. Other roles
  who open the page read "Only workspace admins can manage project automation."
- The workspace must be on Changemaker or higher. Below that, the page shows an upgrade
  prompt. See [tiers and billing](./tiers-and-billing.md).
- A webhook belongs to one project.

## The four events

| Event | Sent when |
|---|---|
| "Conversation started" | A participant starts a new conversation |
| "Conversation transcribed" | All audio has been converted to text |
| "Conversation summarized" | The summary is generated |
| "Report generated" | A report has been generated |

A conversation message carries the participant's name and email, the tags, timestamps and
duration, the project's name, and a link to the conversation in the dashboard. The
transcript is included once the conversation is transcribed, and the summary once it is
summarised. On the page, "What are webhooks? (2 min read)" explains this, and "View example
payload" shows a full example.

If you want one event, take "Conversation summarized": its message already holds both the
transcript and the summary.

## Add and test a webhook

1. Open "Automation" in the project and choose "Add webhook".
2. Choose "Start fresh". Or choose "Clone from another project" to copy the address and
   events of a webhook on another project you manage. A secret is not copied.
3. Fill in "Name" and "Webhook URL". The address must start with http:// or https://, and
   an address on a private or internal network is refused.
4. If your receiver checks signatures, fill in "Secret". Each message is then signed, so
   your system can check that it came from dembrane.
5. Tick the events under "Events to listen for", then choose "Add webhook".

A new webhook is on at once. In the list you can:

- send a sample message with the play button, "Test webhook";
- pause and resume it with the "Enabled" switch;
- change it with "Edit" or remove it with "Delete".

## Delivery

- A message your system refuses is not sent again.
- A message that fails for another reason, such as a timeout or a server error, is tried
  again up to three times.
- The same message can arrive more than once, so make your receiver safe for repeats.

After a downgrade below Changemaker, existing webhooks keep firing. Managing them needs
Changemaker again.

The signature, the exact message format and the retry timing are on the developer page
[webhooks](../users/developer-external/webhooks.md).

## Other ways to connect

- [MCP](./mcp-and-bring-your-own-llm.md) lets an assistant such as Claude or ChatGPT read
  your conversations and transcripts.
- [Export](./export-and-data-portability.md) covers the downloads in the dashboard.

dembrane has no API keys or personal access tokens for your own scripts. Webhooks and MCP
are the two ways to connect another system.

## Related

- [Webhooks for developers](../users/developer-external/webhooks.md): signing, payloads and
  retries.
- [MCP and bring-your-own-LLM](./mcp-and-bring-your-own-llm.md): connect an assistant.
- [Export and data portability](./export-and-data-portability.md): downloads.
- [Tiers and billing](./tiers-and-billing.md) and
  [roles and permissions](./roles-and-permissions.md): the plan and the role this needs.
