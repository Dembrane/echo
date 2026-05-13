# `is_over_cap` stamp at conversation finish

## What to build

When a conversation transitions to finished, the system stamps a durable `is_over_cap` boolean on the conversation row using the soft-edge formula from ADR 0001:

`is_over_cap = NOT tier_allows_overage(workspace.tier) AND (workspace.audio_hours − this_conversation.duration) >= cap.included_hours`

Subtracting the conversation's own duration before comparing means a conversation that *started* under cap stays unlocked even if its recording crossed the cap during the session. Only conversations that began their recording when the workspace was already at the cap get stamped.

Stamping fires on free + pilot finishes only — for pioneer+ the formula evaluates to false and stamping is a no-op. The stamp is durable and never recomputed retroactively, on tier change or otherwise. Read ADR 0001 (`docs/adr/0001-over-cap-conversation-model.md`) before touching this logic — the reasoning matters.

The stamp wires into the existing conversation-finish hook for portal recordings and the equivalent code path on host uploads.

## Acceptance criteria

- [ ] Conversation collection has a new `is_over_cap` boolean field, default false, not user-editable.
- [ ] At conversation finish (`is_finished` flipping true), the stamp is computed once and written.
- [ ] A free conversation finishing at workspace lifetime 0.6h after recording 0.3h stamps false (started under cap).
- [ ] A free conversation finishing at workspace lifetime 1.5h after recording 0.3h stamps true (started over cap at 1.2h).
- [ ] A free conversation finishing at workspace lifetime 1.1h after recording 0.6h stamps false (started at 0.5h, under cap).
- [ ] A pioneer conversation never stamps true regardless of cumulative usage.
- [ ] Both portal recording finish and host upload finish paths apply the stamp.
- [ ] Tier changes do not retroactively re-stamp existing rows.
- [ ] Unit tests cover the soft-edge formula exhaustively (tier × under/at/over × started-under/started-over).

## Blocked by

- Slice 1 (`tier_allows_overage` helper must exist).
