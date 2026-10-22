---
title: Chat & Ask
description: Ask questions about the conversations in a project with the default Specific Details chat or the Beta Agentic assistant, and reuse prompts with templates.
audience: host
---

# Chat & Ask

"Ask" is the chat screen of a project. You choose conversations, ask a question, and get an
answer written from what people said. Use it to compare viewpoints, find a quote or test a
hunch.

There are two kinds of chat. You choose one when you start, and a chat keeps its kind.

| | "Specific Details" | "Agentic" (Beta) |
|---|---|---|
| How you start it | It is the default. Type a question and press "Send". | Press "Try Agentic instead" under the question box. |
| What it reads | The full transcripts of the conversations you attach, and nothing else. | It lists, searches and reads conversations itself, step by step. The ones you select are its focus. |
| What it does | Answers your question. | Shows a plan, answers, and can propose changes to your project for you to accept. |
| Sources | Plain text with no source list. | Numbered sources that open the transcript at the cited part. |
| If you close the page | A reply that is still being written is lost. | The work carries on and your Inbox tells you when it is done. |

## Start a chat

Open "Ask" in the project sidebar. The screen asks "Where would you like to start?" and has
a question box, a "Select conversations" button and "Send". "Send" or Enter starts a
"Specific Details" chat. Shift + Enter adds a line.

Other ways in:

- "Start a chat" on the project "Overview".
- "Ask about these" on the "Conversations" page, after you tick conversations.
- "Set up with the assistant after creating" when you create a project. You land in an
  assistant chat.

Under the box, "Chats" lists the chats that have messages, with a "Search chats" field. A
language model names each chat from its first message. The chat menu has "Rename" and
"Delete".

Older chats in the retired "Overview" mode still open. You cannot start a new one.

## "Specific Details": you choose what it reads

1. Press "Select conversations" and tick the ones you want. "Select all visible ({n})" takes
   the whole list.
2. Type your question and press "Send".
3. Follow up in the same chat.

How it behaves:

- It answers only from the conversations attached to the chat. With none attached it shows
  "Select a conversation to continue" and your question waits in the box.
- It reads the full transcripts and the outcomes participants approved with Verify. It also
  gets the project's name, language, context and key terms.
- It does not search, and it does not pick conversations for you. A conversation that is not
  attached has not been read.
- After you send a message, the conversations it used stay with the chat. A line "Context
  added:" lists them.
- The bar above the box shows how much space each conversation takes. A conversation that no
  longer fits is skipped. One that is larger than the whole space is refused as too long.
  Empty conversations are skipped.
- While a reply is written you can press "Stop". The part already written is kept.
- The reply is plain text. Before you reuse a quote, check it in the
  [transcript](./conversations-and-transcripts.md).

> [!WARNING]
> Keep the page open until a "Specific Details" reply has finished. The reply is saved when
> it is complete, so leaving early loses it.

## The assistant ("Agentic", Beta)

Press "Try Agentic instead", then "Start a new chat" in the "Agentic chat" introduction. In
sentences the product calls this mode "the assistant". It is built for questions that take
several steps, and for help with setting up a project.

An assistant chat stays an assistant chat. A new chat from the Ask screen starts in
"Specific Details" again.

- A plan first. It sends a short plan of at most six steps. The "Plan" card shows
  "{n} of {total} done" and ticks the steps off. A line under it names the current step, for
  example "Reading {name}'s transcript".
- It works on the server. The card says "You can close this page. We'll notify you when it's
  done." If a run ends while the chat is closed, you get an Inbox notification such as "Your
  answer in {chat name} is ready". No email is sent.
- Your selection is a focus. The box shows "Focusing on # conversations:". The assistant
  reads what it needs, and reads a long list in batches.
- Sources. It marks a claim with a numbered source. Click it and press "Open conversation"
  to open the transcript at the cited part.
- Voice. "Record a voice message" puts your words in the box as text, so you can check them
  before you send. A recording stops at five minutes and counts against the workspace's
  recording hours.
- Stopping. "Cancel" on the live line stops a run. One turn can run for up to 10 minutes.
- Only the person who started a run can follow, continue or stop it.

### What the assistant can read

It reads with your rights, so it sees what you may see in the project:

- conversations, their summaries and full transcripts, which it can list and search;
- whether a recording is live right now;
- the project's settings, tags, portal link, reports, goal and methodology;
- earlier chats in the project.

### What the assistant can change

It changes your project only through a card that you accept.

| What | Card | You press |
|---|---|---|
| Project settings | "The assistant suggests updating {fields}. Waiting on you." | "Accept", "Add a note" or "Dismiss" |
| Tags | "Suggested tag changes for your project" | "Apply" or "Dismiss" |
| A verification prompt | "Suggested verification prompt" | "Add verification prompt" |
| The project goal | "Suggested project goal" | "Apply" or "Dismiss" |
| A new [canvas](./canvas.md) | A card with a "Brief" | "Try it", "Apply" or "Dismiss" |

The settings card shows "Current" and "Proposed" for each field. Untick a field to leave it
as it is, or press "Edit" to change the proposed text. Accepting needs permission to edit
the project. A waiting card sends no notification, so look for "Waiting on you." in the
chat.

It does three things without a card:

- It saves, changes and removes its own memory notes (see below).
- It changes a canvas that already exists: edit, add, remove, pause, resume, stop.
- It logs a support request with the dembrane team. It tells you the request is logged. It
  does not promise when someone will reply.

It can also draft a note "for the dembrane team". That card says "Nothing is sent until you
send it. Edit anything below first." and has the button "Send to dembrane".

It cannot generate a report, start a map or change a presentation.

## Templates

A template is a saved prompt that you insert into the question box.

- A row above the box shows suggestions ("Suggested:") and your pinned templates, then
  "Manage templates". Typing "/" in an empty box opens the "Templates" window.
- Built in for "Specific Details": "Summarize", "Compare & Contrast", "Meeting Notes" and
  "Strategic Planning".
- Built in for the assistant: "Project Meta Summary", "Compare & Contrast Insights",
  "Highlight specific Concept", "Narratives (English)" and "Narratieven (Nederlands)".
- You can pin at most five templates.
- "Create template" saves your own, with a "Template name" and a "Prompt". "Save as
  template" does the same from a question you already sent.
- "Share with workspace" makes a template "Visible to everyone in this workspace." Members
  and admins can share. Leave it off to keep the template personal.
- "Contextual suggestions" is the switch for the suggested follow-up questions. A language
  model writes up to three, from the conversations' summaries, the last reply and your
  recent questions.

## Memory and standing guidance

The assistant keeps notes across chats. Only the assistant writes them. You can read them
and remove them: "Remove this memory?" and then "The assistant forgets it in every future
chat."

| Notes about | Where you find them | Who shares them |
|---|---|---|
| You | User settings, "Assistant", card "Memory" | Only you |
| The project | Project "Manage", "General", "Assistant memory" | Everyone who chats in the project |
| The workspace | Workspace settings, "Assistant memory" | Everyone in the workspace |

A chat starts with the 12 newest notes. The assistant is instructed to keep private or
personal information out of project and workspace notes. Remove a note that should not be
shared.

Workspace admins can also write "Assistant context" in workspace settings: "Standing
guidance the assistant gets in every project chat in this workspace." It holds up to 4,000
characters. Each chat also gets the project's context and goal.

## Checking and rating replies

Under the box the product says: "dembrane can make mistakes. Please double-check responses."
A language model writes every reply, so treat it as a draft and read the source.

Every reply has "Good response" and "Poor response". "Poor response" asks "What went
wrong?". Your feedback and the reply go to the dembrane team.

## Who can use Ask

- Admins, members and external collaborators can chat. Observers do not see "Ask" in the
  sidebar. See [roles & permissions](./roles-and-permissions.md).
- Ask needs no paid plan. On the Free plan an account starts two new chats a month, and a
  chat takes 20 questions. After that the chat shows "Upgrade to continue". A chat from an
  earlier month takes no new questions. See [tiers & billing](./tiers-and-billing.md).
- Replies are written by Gemini models served from an EU endpoint.

## Related

- [Conversations & transcripts](./conversations-and-transcripts.md): what Ask reads, and
  where sources open.
- [Reports](./reports.md): one written article from the whole project.
- [Map](./argument-map.md) and [Present](./present.md): arguments and live results without
  asking a question.
- [Canvases](./canvas.md): a live page you ask the assistant for.
- [Chat & Ask for hosts](../users/host/chat-and-ask.md): the walkthrough.
