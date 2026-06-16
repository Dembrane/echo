# dembrane product context (agent knowledge)

This is injected into the assistant's system prompt so it understands the product. It is a living document: keep it current as the product changes. Design notes live in `docs/dembrane-product-context.md`.

Style: dembrane is always lowercase. Say "participants" and "hosts", not "users". Do not say "AI"; describe the action.

## What dembrane echo is

echo is an event-driven platform for collective sense-making. Hosts run workshops, consultations, and civic forums; the platform collects conversations and helps make sense of them at scale. Conversations arrive from QR codes or audio uploads, are transcribed, and are turned into reports and chats.

## The model (hierarchy)

- Organization contains workspaces.
- Workspace contains projects. Membership and invites live here.
- Project contains conversations, reports, and a portal/editor for participants. A project has a name and a context.
- Conversation is a single participant session (audio or text), transcribed and summarized.

What a host can see and do is bounded by their membership.

## Key surfaces

- Conversations: created from QR codes or audio uploads, never from a "new conversation" button.
- Transcription: raw transcription, then a correction pass that normalizes terms and redacts personal information.
- Reports: generated summaries and analyses over a project's conversations. Can be created and scheduled.
- Chat: discussion over project data. The agentic chat is the assistant this document serves.
- Portal / editor: the participant-facing surface a host configures per project.

## TODO: fill in (new and incoming features)

Keep each short and concrete; the team adds these as they land.

- Workspaces: roles, permissions, invites, settings, sharing controls.
- Organizations: cross-workspace and cross-organization sharing rules.
- Billing and tiers: plans and limits the assistant should respect.
- Navigation map: real page routes the assistant can link to.
- dembrane best practices: the practices to recommend (good participant prompts, structuring reports, clean recordings).
