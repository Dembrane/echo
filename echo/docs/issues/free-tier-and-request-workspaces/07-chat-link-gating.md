# Chat-link gating

## What to build

A locked conversation cannot be added to a chat. The gate fires at the chat-conversation link insert point and at the auto-select pickup path; both reject locked conversations.

Pre-existing links are unaffected. A chat that was already linked to a conversation that *later* becomes locked keeps running fully — history loads, new messages send, the LLM continues to receive the full transcript text of those pre-existing links. The lock is a new-engagement gate, not a content-extraction gate. This loophole is intentional and documented in ADR 0001 — the alternative (chat suddenly degrading mid-conversation) is more hostile.

UI: the "Start chat" affordance on a locked conversation is disabled with a tooltip explaining the lock.

## Acceptance criteria

- [ ] Adding a locked conversation to a chat via the link insert returns 402 with a structured error code identifying the lock.
- [ ] Auto-select pickup filters out locked conversations from its candidate set.
- [ ] The frontend disables the "Start chat" button on locked conversations and shows a tooltip.
- [ ] A chat already linked to a now-locked conversation continues to load full history.
- [ ] Sending a new message in a chat with a pre-existing link to a now-locked conversation succeeds and streams a reply.
- [ ] The LLM receives the full transcript text of pre-existing links during chat send (verified by inspecting the prompt).

## Blocked by

- Slice 4 (`is_over_cap` exists on conversations)
- Slice 5 (live `locked` gate available for the check)
