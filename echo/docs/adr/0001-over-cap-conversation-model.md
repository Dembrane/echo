# Over-cap conversation model

## Status
accepted (2026-05-11)

## Context
The free and pilot tiers have hour caps with no overage. Once a workspace exceeds its cap, we need to gate access to new content without breaking recording. We considered four shapes for "which conversations are locked":

1. Hard-block recording at the cap (today's pilot behavior).
2. Stamp `is_over_cap` at conversation creation, freeze at that boundary.
3. Stamp at finish, compare against `hours_used_after_finish ≥ cap` (sharp edge — the conversation that crossed the cap locks).
4. Stamp at finish, compare against `hours_used_before_this_conversation ≥ cap` (soft edge — any conversation that *started* under cap stays unlocked).

## Decision
- Recording **never** fails. Hard-block is removed everywhere, including for pilot. Participants can always record from the portal.
- `is_over_cap` is stamped at finish (when `is_finished` flips true), using the soft-edge formula: `is_over_cap = NOT tier_allows_overage(tier) AND (workspace.audio_hours − this_conversation.duration) ≥ workspace.hours_included`.
- Stamping only fires on the two non-overage tiers (free, pilot). Pioneer+ conversations are never stamped, even when over their monthly bucket — those tiers bill overage.
- The lock UI is **live-computed**, not stored: `locked = is_over_cap AND NOT tier_allows_overage(workspace.current_tier)`. Tier upgrades auto-unlock previously-locked conversations with no batch update or cache bust. The stamp is durable for accounting/audit.
- Pilot → free downgrade (manual or via expiry cron) does **not** re-stamp historical pilot content. A user who used 7 of 10 pilot hours keeps all 7 hours readable forever after downgrade, even though free's cap is 1 hour. The downgrade gates *future* recording only.
- Chat is gated at the `project_chat_conversation` insert (and auto-select pickup), not at message-send time. Chats already linked to a conversation that *later* becomes locked keep running, and the LLM receives the full transcript text of those pre-existing links. The lock is a new-engagement gate, not a content-extraction gate.

## Consequences
- **`is_over_cap` is a permanent stamp, not the gate.** A future reader looking at the column will assume "this means locked." It does not. Locking is `is_over_cap AND NOT tier_allows_overage(current_tier)`, computed live. The stamp records the historical moment; the tier decides whether to enforce it now.
- **The lock has known loopholes by design.** A user can extract locked transcript content through a pre-existing chat thread. A user can deliberately over-record on free knowing the conversations that *started* under cap stay unlocked. These are accepted because the alternative (mid-recording aborts, retroactive chat breakage, retroactive content lock on paid-trial data) is more hostile than the workaround is valuable to abusers.
- **No background re-stamping on tier change.** Cleaner code (one transactional tier update, no follow-up sweep), but it means the `is_over_cap` column doesn't reflect "is currently locked" — only the original moment. Reports/CSVs need to be written against the live formula if they want current state, not the raw stamp.
- **Pilot is a quietly paid feature now.** A workspace that did its 10-hour trial keeps unlimited read access to those 10 hours forever, even on free. This is intentional — pilot is a paid product, and locking paid content at trial expiry would generate refund requests.
