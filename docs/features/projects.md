---
title: Projects
description: A project holds a set of conversations and everything made from them. How to create one, where its settings live, and how to share, clone, move and delete it.
audience: host
---

# Projects

A project holds the conversations that belong together and everything made from them:
transcripts, summaries, chats and reports. A good rule is one question or one engagement per
project. If you would report on it as one thing, it is one project.

Projects live in a [workspace](./organisations-and-workspaces.md). The workspace home lists
them, with a "Search projects" box and a "Create project" button.

## Who can do what

| You want to | Workspace role you need |
|---|---|
| Open a project and read its conversations | Any role except billing |
| Change settings, the portal, tags and summaries | Owner, admin, member or external |
| Create or clone a project | Owner, admin or member |
| Delete or move a project, or make it private | Owner or admin |

The full table is on [roles and permissions](./roles-and-permissions.md).

## Create a project

Choose "Create project" on the workspace home. There are four steps, and only the name is
required.

1. "Name". Fill in "Project name" and "Project context". The context says what the project
   is about and what you want to learn. dembrane uses it when it writes summaries, answers
   in chat and replies to participants. Switch on "Set up with the assistant after creating"
   if you want to land in a chat that helps you shape the project.
2. "Key terms". Add the people, places, organisations and jargon you expect to hear, so that
   [transcription](./transcription.md) spells them right. You can skip this and add them
   later.
3. "Access". Choose "Open to the workspace" (the default) or "Private". Private needs a
   workspace on Innovator or higher.
4. "Review". Check the summary, then choose "Create project".

You land on the project's "Overview", or in a chat with the assistant if you switched that
on.

A new project can take conversations at once. It asks participants for a name, shows no
tutorial, and takes its language from your own interface language: Dutch if you use dembrane
in Dutch, English in every other case. Change any of this in the
[portal editor](./portal-editor.md).

## What the project language does

The language is one setting, "Language" in the portal editor, with three effects:

- The portal opens in that language when people use your link or QR code.
- Transcription gets it as a hint. It does not force the output language: the model is told
  to trust the audio and to transcribe what is spoken, other languages included.
- Summaries, generated titles and verification outcomes are written in it.

## Inside a project

The project sidebar is the map of a project:

| Entry | What it is |
|---|---|
| "Overview" | The project's home: the "Take part" card with the QR code and the link, the list of conversations, a summary of the portal settings, and shortcuts such as "Upload audio" and "Host guide" |
| "Ask" | [Chat](./chat-and-ask.md) with the project's conversations. Hidden for observers |
| "Conversations" | The [recordings and uploads](./conversations-and-transcripts.md) |
| "Portal editor" | [What participants see](./portal-editor.md) in the portal |
| "Monitor" (Beta) | A [live view](./live-monitor.md) of recording sessions |
| "Present" (Beta) | The page you prepare and open the [room's screen](./present.md) from |
| "Map" (Beta) | The [argument map](./argument-map.md) of the project |
| "Report" | Written [reports](./reports.md) |
| "Automation" (Beta) | Project [webhooks](./webhooks-and-integrations.md). Workspace admins and owners only |
| "Manage" | "General", "Access", "Usage" and "Export" |

## Where each setting lives

| Setting | Where | What it does |
|---|---|---|
| "Name" | "General", or "Rename project" in the project's menu on the workspace home | The name in the dashboard. Participants do not see it in the portal. It is printed on the host guide. |
| "Project context" | "General" | What the project is about. Used for summaries, chat answers and replies to participants. |
| "Project goal" | "General" | Free text with a revision history. It guides reports and the assistant's suggestions. |
| "Methodology" | "General" | The way the project is set up and guided, chosen from the methodologies your workspace can see. |
| "Experimental" | "General" | One switch, "Living canvas and popcorn" (Beta), which turns on [canvases](./canvas.md) for the project. |
| "Language", "Key terms", "Tags" and every portal option | [Portal editor](./portal-editor.md) | What participants see and how transcription is guided. |
| Visibility | "Access" | Who on the workspace can see the project. |

## Who can see a project

A project is either "Open to the workspace" or "Private".

- Open: everyone on the workspace can see it and work in it as far as their role allows.
- Private: only the workspace's admins and owners, and the people you share it with, can
  see it. A share opens the project and nothing more. What the person can do in it still
  comes from their workspace role.

A workspace admin or owner changes this on the "Access" tab, with "Make private", "Share
with someone" and "Share with whole workspace". Making a project private and sharing it
need Innovator or higher. Opening it to the workspace again never needs a plan.

You share by email address. Someone who is not on the workspace yet gets an invite, and the
project is shared when they join. A person with the billing role cannot open projects, so
give them another role first.

## Find, pin and rename

- "Search projects" filters the list by name. To search conversations, transcripts and chats
  across projects, use "Search" in the sidebar.
- You can pin up to three projects per workspace. Pins are shared: everyone on the workspace
  sees the same "Pinned" section. External and observer roles cannot pin.
- The three dots on a project row hold "Rename project" and "Configure portal".

## Clone, move and delete

All three are under "General".

- "Clone project" makes a copy in the same workspace. Settings and tags are copied.
  Reports, chats and conversations are not.
- "Move to another workspace" moves the project with its conversations and reports. Members
  of the current workspace lose access. You must be admin or owner of both workspaces, and
  both must share the same billing and data ownership. A workspace run for an external
  client stands on its own, so a project cannot move into or out of it this way.
- To move several projects, choose "Select" on the workspace home, tick the projects, then
  "Move projects". If one of them is not allowed to move, none move.
- "Delete project" asks you to confirm twice and cannot be undone. Only owners and admins
  see the button.

## Related

- [Organisations and workspaces](./organisations-and-workspaces.md): where a project lives.
- [The portal editor](./portal-editor.md): what participants see when they record.
- [Recording](./recording.md): the QR code, the link, the host guide and audio upload.
- [Conversations and transcripts](./conversations-and-transcripts.md): what fills a project.
- [Roles and permissions](./roles-and-permissions.md) and
  [tiers and billing](./tiers-and-billing.md): who can do what, and what each plan includes.
- [Creating a project](../users/host/creating-a-project.md): the same steps as a host guide.
