# Live `locked` gate + transcript overlay

## What to build

Conversation responses expose a derived `locked: bool` per conversation, computed live at read time:

`locked = conversation.is_over_cap AND NOT tier_allows_overage(workspace.current_tier)`

The raw `is_over_cap` column is admin/CSV only and is not exposed to the frontend. When `locked` is true, chunk responses scrub the transcript field and mark the envelope `transcript_locked: true`; audio fields remain intact. The frontend renders a single new `LockedTranscriptOverlay` component in place of the transcript text on host conversation pages, library snippets, and chunk audio transcripts, with an "Upgrade to view transcripts" CTA. The audio player stays accessible everywhere.

Upgrading a workspace to a tier with `tier_allows_overage=true` causes every previously-locked conversation to become readable again on the next page load, with no batch update, no cache bust, no re-stamping. Pilot → free downgrade does NOT lock conversations that were stamped is_over_cap=false on pilot — paid-trial content stays readable on free forever.

See ADR 0001 for the design rationale.

## Acceptance criteria

- [ ] BFF conversation responses include a derived `locked` boolean per conversation.
- [ ] Raw `is_over_cap` is not exposed to the frontend in BFF responses.
- [ ] When `locked` is true, chunk responses set `transcript=null` and `transcript_locked=true` on the chunk envelope; audio fields are intact.
- [ ] The host conversation transcript view renders the LockedTranscriptOverlay instead of transcript text when locked.
- [ ] The library snippet view shows a small lock chip on locked conversations.
- [ ] The chunk audio transcript view renders the overlay when locked.
- [ ] Audio playback remains usable on locked conversations.
- [ ] Upgrading a free workspace to innovator immediately unlocks all previously-locked conversations on the next page load.
- [ ] Pilot → free downgrade leaves conversations stamped is_over_cap=false on pilot fully unlocked.

## Blocked by

- Slice 3 (workspace usage hook surfaces tier and cap state)
- Slice 4 (`is_over_cap` stamp exists on conversations)
