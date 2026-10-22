---
title: Chat & Ask for hosts
description: What Ask can do in a project, from the default Specific Details chat to the Beta Agentic assistant, with templates and good first questions.
audience: host
---

# Chat & Ask for hosts

"Ask" is the chat screen of a project. You pick conversations, type a question, and a language
model answers from what people said in them. It does not replace reading the transcripts. It
helps you find what is worth reading.

## What Ask can do

| You want to… | Use |
|---|---|
| Find quotes, details and summaries in conversations you pick | "Specific Details", the default chat |
| Work through a bigger question across many conversations, step by step | "Agentic", the assistant |
| Get help setting up your project | "Agentic", the assistant |
| Ask the same thing of many conversations and get the same format back | "Templates" |

Ask does not write a report, generate a map or change a presentation. Those have their own
pages: [reports](./reports.md) and [Present and Map](./present-and-map.md).

People with the "Admin", "Member" or "External" role can use Ask. Observers do not see it in
the sidebar.

## Start a chat

1. Open your project and choose "Ask" in the sidebar.
2. Press "Select conversations" and tick the ones you want to ask about. "Select all visible"
   ticks the whole list.
3. Type your question and press "Send" or Enter. Shift + Enter adds a line.

There are two more ways in: "Start a chat" on the project's "Overview" page, and "Ask about
these" on the "Conversations" page after you tick conversations there.

This starts a "Specific Details" chat. Good to know:

- Nothing is selected for you. The chat answers only from the conversations you attached. With
  none attached it shows "Select a conversation to continue", and your question waits in the box.
- The language model gets the full transcripts of those conversations, the outcomes
  participants approved during verification, and your project's name, language, context and key
  terms. Clear [project context](./creating-a-project.md) makes every answer sharper.
- A chat holds a limited amount of transcript. The bar above the box shows how much each
  conversation takes. A conversation that no longer fits is skipped, and so is an empty one. In
  a large project, attach the conversations that matter for the question.
- You can add conversations later in the same chat. The ones a chat has used stay with it. For
  a different set, start a new chat.
- Replies are plain text with no list of sources. Ask for quotes, then check them in the
  [transcript](./transcripts-and-conversations.md). The screen says it too: "dembrane can make
  mistakes. Please double-check responses."
- Stay on the page until the reply is complete. A reply is saved when it finishes, so leaving
  earlier loses it. "Stop" keeps the part already written.

Your chats are listed under "Chats", with a "Search chats" field. Each chat gets a name from
your first question. The chat's menu has "Rename" and "Delete".

## Good first questions

Start broad, zoom in, then ask for evidence:

1. "What are the main themes?"
2. "What concerns came up about the bus route?"
3. "Show me the quotes."

This works well for comparing viewpoints, finding quotes and testing a hunch. After each reply,
up to three follow-up questions appear above the box under "Suggested:".

## Templates

A template is a saved prompt that you drop into the question box.

- The row above the box shows suggestions and your pinned templates. "Manage templates" opens
  the "Templates" window. Typing "/" in an empty box opens it too.
- Built in for "Specific Details": "Summarize", "Compare & Contrast", "Meeting Notes" and
  "Strategic Planning". The first three start out pinned. You can pin up to five.
- "Create template" asks for a "Template name" and a "Prompt". "Save as template" on a question
  you already sent does the same job.
- "Share with workspace" makes your template visible to everyone in the workspace. You need the
  "Member" or "Admin" role to share. Leave it off to keep the template personal.
- After you pick a template the screen shows "Template applied" with "Undo".

A good template gives the language model a structure to fill, so many conversations come back
in the same format and are easy to compare. Put what you expect in square brackets:

```
For each conversation, give me:
[Title]
[Description, max 100 words]
[One quote taken directly from the transcript, in the original language, with an English translation]
```

Start small. Chat tends to give more than you asked for, and a short template keeps it on
track.

## The assistant

"Agentic" is a second chat mode, marked Beta. The interface calls it the assistant. To try it,
press "Try Agentic instead" under the question box on the Ask screen, then "Start a new chat".

What is different from "Specific Details":

- It plans. It shows a "Plan" of up to six steps and ticks them off while it works.
- It reads for itself. The conversations you select are a focus, not a fixed set, and the
  transcript limit of the default chat does not apply. It can also read summaries, reports, the
  project's settings and tags, and earlier chats.
- It keeps working when you leave. The plan says "You can close this page. We'll notify you
  when it's done." The notice lands in your "Inbox".
- It shows its sources. A claim carries a numbered source. Click it, then "Open conversation",
  to land on the cited part of the transcript.
- It proposes and you decide. Changes to project settings, tags, verification prompts and the
  project goal arrive as a card. Nothing changes until you press "Accept" or "Apply". "Dismiss"
  leaves everything as it was.
- You can speak. "Record a voice message" turns up to five minutes of speech into text in the
  box, for you to check before you send it. This uses the workspace's recording hours.

An empty assistant chat offers three starters: "List my conversations", "What themes came up?"
and "Improve my setup". Its built-in templates include "Project Meta Summary", "Narratives
(English)" and "Narratieven (Nederlands)".

"Cancel" stops a run. One request can run for up to ten minutes. Only the person who asked can
follow, continue or stop it.

A chat keeps the mode it started in. Old chats in the retired "Overview" mode still open, but
you cannot start a new one.

### What the assistant remembers

The assistant saves short notes across chats, without asking first, in three places:

| Notes about | Where you see them | Who sees them |
|---|---|---|
| You | Your user settings, "Assistant" | Only you |
| The project | The project's "Manage" menu, "General", "Assistant memory" | Everyone who chats in the project |
| The workspace | Workspace settings, "Assistant memory" | Everyone in the workspace |

You cannot write or edit a note. "Remove" makes the assistant forget it in every future chat.
Workspace admins can also give it
[standing context](./managing-your-workspace.md#give-the-assistant-standing-context).

With "Living canvas and popcorn" switched on for a project (in "Manage", "General",
"Experimental"), the assistant can also propose a [canvas](../../features/canvas.md): a live
page built from recent conversations.

## Limits

- Free plan: two new chats a month and 20 questions per chat, for the whole account. At the
  limit the chat shows "Upgrade to continue" and "See upgrade options". See
  [tiers, billing and usage](./tiers-billing-and-usage.md).
- Free plan: a chat from an earlier month stays readable but takes no new questions. Start a
  new chat instead.
- No paid plan is needed for either chat mode.

Answers in both modes come from Gemini language models served from an EU endpoint.

## Rate an answer

Every reply has "Good response" and "Poor response". A thumbs down asks what went wrong, with
room for a note. Your feedback and the reply go to the dembrane team.

## Related

- [Chat & Ask feature reference](../../features/chat-and-ask.md): every detail of both modes.
- [Reports](./reports.md): one written article from the whole project.
- [Present and Map](./present-and-map.md): show results to a room, explore the arguments.
- [Transcripts and conversations](./transcripts-and-conversations.md): where to check a quote.
- [Managing your workspace](./managing-your-workspace.md): standing context for the assistant.
- [Getting help](./getting-help.md): feedback, bug reports and support.
