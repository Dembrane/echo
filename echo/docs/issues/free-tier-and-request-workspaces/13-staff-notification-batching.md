# Staff notification batching (>5/24h → digest)

## What to build

When staff receive more than 5 notification emails of the same event code within a trailing 24h window, additional emails for that code switch to a daily digest. A pure `should_send_now(recipient, event_code, history_24h) -> "individual" | "queue_for_digest"` helper makes the decision; a separate daily Dramatiq actor at 09:00 UTC flushes queued digests, sending a single summary email per recipient per day.

Critically, the **in-app notification continues to fire individually for every event** — only the *email* is batched. The volume problem this solves is inbox saturation during high-request periods, not in-app noise.

Different event codes are tracked independently. Different recipients are tracked independently. A recipient who has received fewer than 5 of an event in the trailing window continues to receive individual emails.

This slice applies broadly — any future event code can use the same throttle helper. For now, the only event code actually wired through it is `WORKSPACE_REQUEST_SUBMITTED` (the only one with realistic batch volume); other codes opt in if needed.

## Acceptance criteria

- [ ] `should_send_now(recipient, event_code, history_24h)` returns `"individual"` for the first 5 events of a code per recipient in 24h, `"queue_for_digest"` for the 6th and later.
- [ ] Events older than 24h drop out of the count (sliding window).
- [ ] Different event codes are tracked independently for the same recipient.
- [ ] Different recipients are tracked independently for the same event code.
- [ ] A daily Dramatiq actor runs at 09:00 UTC and flushes queued digests as one email per recipient.
- [ ] Each digest email summarises the queued events with enough context for staff to act (no links lost).
- [ ] In-app notifications continue to fire individually regardless of batching state.
- [ ] `WORKSPACE_REQUEST_SUBMITTED` is wired through the throttle.
- [ ] Unit tests exhaustively cover the throttle decision function.

## Blocked by

- Slice 12 (notification emission infrastructure exists).
