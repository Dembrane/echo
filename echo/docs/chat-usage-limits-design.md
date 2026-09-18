# Chat usage limits

Per-host token budget for chat, with a session window that resets on a timer.
Modelled on how Claude and ChatGPT limit chat: you spend freely until you hit
the ceiling, then you wait for a reset.

Status: design approved, not implemented. Open items at the bottom.

Revision 6. Tier ownership stays open.

## Decisions at a glance

Every decision in this document, one line each. The sections below give the
reasoning.

**Scope**

- Budget belongs to the authenticated host, across every chat, project and
  workspace.
- Only the two chat surfaces draw it down: agentic and legacy project chat. Not
  reports, transcription or suggestions.

**The window**

- Session window anchored on first use: opens on the first accepted message,
  closes `window_seconds` later, never extended.
- Five hours today, configurable, one global length for everyone.
- `PEXPIREAT` is written once at birth, so the TTL is the reset.
- Expiry is decided by comparing `now` to `reset_at`, never by key presence,
  because the key outlives the window by `settle_grace`.

**The budget**

- Budgets vary by tier, resolved like `resolve_concurrent_recording_cap`; the
  window length does not.
- Budget and accounting policy are frozen into the window at birth, so config,
  tier or workspace changes never move a live ceiling.
- Operational sweep timings are read live, since they are incident controls
  with no accounting meaning.
- Support can raise one account's budget via a nullable
  `chat_token_budget_override` in Directus, applying to windows born after.

**Enforcement**

- Check before the turn, never mid-stream, so no answer is ever truncated.
- Admission is provisional until `claim` at execution start; a started turn
  always finishes, a waiting one gets re-judged.
- Nothing reads a reservation until expiry is resolved, in both `admit` and
  `claim`.
- Admission and reservation are one atomic Lua operation, so parallel tabs
  serialize in Valkey.
- The reservation is fixed occupancy, not a cost estimate; its job is bounding
  concurrency at `budget / reservation_units`.
- Occupancy is reserved at `admit`, freed at `release`, never at `settle`.
- Reservations are swept on heartbeat staleness, and the sweep runs inside
  `admit` so it is self-healing with no background job.
- Both surfaces heartbeat with a periodic task, because no whole-turn deadline
  is actually enforced anywhere.

**Metering**

- Charge real `usage_metadata` from `on_chat_model_end`, summed per model
  invocation so tool loops are counted.
- `litellm.token_counter` is the fallback, and every fallback debit is tagged
  `estimated`.
- Dedupe on the model `run_id`, so replays are free and genuine retries are
  charged.
- Debits attribute by `window_id`, so a late completion can neither charge the
  new window nor resurrect the old one.
- Units are integers, `ceil(input + weight * output)`, keeping `spent` exact
  for the Lua comparisons.
- Meter raw tokens at weight 1.0, with the weight as a setting so output can be
  priced later.

**Failure**

- Every quota operation fails open and logs; admission also emits
  `chat_limit_unenforced`.
- An unenforced admission issues no `window_id`, so its settles can never
  charge a window born later.
- A flush costs one fresh window; a sustained outage is unenforced for its
  whole duration and is not bounded.
- Redis holds enforcement state, PostHog holds the audit trail, and the audit
  trail cannot rebuild the counter.

**Surfacing**

- 429 with `Retry-After`, not 402, because waiting is free.
- Distinct `CHAT_USAGE_LIMIT` error and a separate `chatLimit.ts`, so a cooldown
  never reaches the upgrade modal.
- Denials say why: `limit_reached` waits for reset, `concurrent_turns` retries
  in seconds and does not disable the composer.
- A claim rejection is sent before the response opens, and agentic also marks
  the run failed so other attached clients learn.
- A read-only status endpoint that never opens a window, reads an expired one
  as empty, and returns `ok` when Redis is down.
- Silent while there is room, a quiet notice past `warn_ratio`, a disabled
  composer at the limit, no always-on gauge.

**Deliberately not built**

- No Directus usage ledger, so enforcement state is not recoverable.
- No pre-flight estimation, no mid-stream abort, no per-tier window lengths.

**Still open**

- Tier ownership across multiple billing accounts, the reservation size, the
  80th-percentile budget, and production Valkey persistence.

## Behaviour

- The budget belongs to the authenticated host, across every chat, project and
  workspace they touch.
- The window opens on the first accepted message and closes `window_seconds`
  later (5 hours today, configurable). Later activity never extends it.
- **Admission is provisional until execution starts.** A turn that has begun
  producing an answer always finishes, including every agent step, even past
  the budget. A turn that was admitted but has not started yet is re-gated at
  execution start. See Admission is provisional.
- The budget and the accounting policy are frozen when the window is born. A
  config change, a tier change or a workspace switch mid-window never moves the
  ceiling under a live window. See What is frozen.

## What counts

Real token usage from the language model, not an estimate.

`agentic_worker.py` already consumes the agent service's LangGraph events and
parses `on_chat_model_end` at `_extract_model_text_and_tool_calls`. LangChain
puts `usage_metadata` in the same `kwargs` dict that function already reads.

Verified against the live agent venv (langchain-core 1.2.11):

- `AIMessage.to_json()` carries `usage_metadata` in `kwargs`.
- Streaming is not lossy. `langchain_google_vertexai` converts Gemini's
  cumulative per-chunk usage into deltas
  (`_gemini_chunk_to_generation_chunk`), and LangChain's chunk reducer sums
  them back to the true total.
- The graph loops `agent -> tools -> agent` and emits one `on_chat_model_end`
  per model invocation. Summing them charges the whole turn including tool
  steps. Counting visible assistant text would miss most of it.

No agent-service change is needed.

Fallback: when `usage_metadata` is absent, estimate with
`litellm.token_counter` and tag the analytics event `estimated: true`, so the
guessing is visible and measurable.

## Two identifiers, and why they must not be confused

This is the distinction the whole design turns on.

- **`turn_id`** is minted at admission. One per accepted message. It owns the
  reservation, and the reservation lives until the turn ends.
- **`run_id`** is LangChain's per-model-invocation id, already extracted by the
  worker. One turn produces many. It owns the debit and the dedupe marker.

A turn debits many times and reserves once. Releasing occupancy on the first
debit would free the slot while the agent was still working, which defeats the
concurrency bound entirely.

## Turn duration is not bounded, so every turn heartbeats

An earlier revision claimed legacy chat was bounded at 300 seconds by
`timeout=300` at `api/chat.py:1215`. **That is wrong, and the claim is
withdrawn.** `chat.py:1207` calls `arouter_completion`, which goes through the
Router with `ROUTER_NUM_RETRIES = 3` and fallbacks configured
(`llm_router.py:34`, `llm_router.py:192`). So:

- `timeout` is per attempt, not per turn. Four attempts is 1200s.
- `stream_timeout` bounds the gap between chunks, not the stream's total
  length. A steadily streaming response is not bounded by it.
- Fallback to another deployment restarts the clock again.

No whole-turn deadline is enforced on either surface, so no reservation TTL
derived from one can be trusted.

**Therefore both surfaces heartbeat**, and `reservation_stale_seconds` is
derived from the heartbeat interval with margin, not from any turn length.

**The heartbeat is a periodic task on both surfaces, never driven by output.**

| Surface | Heartbeat |
|---|---|
| Agentic | `_refresh_lease_until_done` (`agentic.py:818`), already a periodic task running for exactly the turn's lifetime |
| Legacy chat | A periodic task started at execution start and cancelled in `finally`, modelled on `_refresh_lease_until_done` |

An earlier revision put the legacy heartbeat in the `async for chunk` loop.
That was wrong: it stops beating during exactly the periods the turn is most
likely to be reaped. A turn waiting on its first token, retrying, or sitting in
a router cooldown produces no chunks for minutes while the request is very much
alive, and `stream_timeout` allows 180 seconds between chunks on its own.

So the condition being reaped on is "the process running this turn is gone",
not "no output right now". Copy the agentic shape exactly: create the task
alongside the work, cancel it in a `finally`.

## Redis data model

One hash per host: `dembrane:chat_limit:{user_id}`

| Field | Meaning |
|---|---|
| `window_id` | uuid minted when the window opens |
| `reset_at` | epoch ms, when the window closes |
| `spent` | settled tokens, integer |
| `budget` | frozen at birth |
| `window_seconds` | frozen at birth |
| `warn_ratio` | frozen at birth |
| `output_weight` | frozen at birth |
| `reservation_units` | frozen at birth |
| `expires_at` | frozen at birth, `reset_at + settle_grace`, mirrors `PEXPIREAT` |
| `resv:{turn_id}` | reserved units for one in-flight turn |
| `beat:{turn_id}` | epoch ms of that turn's last heartbeat |

Plus `dembrane:chat_limit:seen:{run_id}`, a dedupe marker per model
invocation.

Note this is Valkey 8, not Redis.

### What is frozen

Frozen at birth: `budget`, `window_seconds`, `warn_ratio`, `output_weight`,
`reservation_units`, and `settle_grace` by way of `expires_at`.

`settle_grace` is frozen because it has already been spent: `PEXPIREAT` is
written once at birth and never updated, so changing the setting cannot move
an existing key's expiry. An earlier revision described it as taking effect
immediately, which contradicted the fixed expiry. It is stored as `expires_at`
so readers never have to recompute it from a setting that may since have
changed.

Read live: `reservation_stale_seconds`, `reservation_start_grace_seconds`,
`heartbeat_interval_seconds`. These are evaluated at sweep time, carry no
accounting meaning, and an operator raising one during an incident should see
it take effect immediately.

## Five operations

All five are Lua. Each checks window identity and the reservation's existence
in the same round trip, because a check followed by a separate write is exactly
the race this design exists to avoid. Take the clock from `redis.call('TIME')`,
not the app, so every API instance agrees.

### `admit` (when the message is accepted)

**The order of the first two steps is load-bearing.** Expiry is resolved before
any reservation is read, or a stale reservation answers for a window that has
already ended.

1. **Rollover, first.** If the key is missing, or `now >= reset_at`, `DEL` the
   key and recreate it: new `window_id`, `reset_at = now + window_seconds`,
   `spent = 0`, `expires_at`, and the resolved budget and frozen policy. The
   `DEL` matters twice over: reservations from the old window must not survive
   into the new one and eat its budget, and they must not survive to satisfy
   the idempotence check below. Set `PEXPIREAT` to `expires_at` once, here, and
   never again. This is the only place a window is born.
2. **Idempotence, second.** If `resv:{turn_id}` still exists after step 1,
   return the original ADMIT with the stored `window_id` and `reset_at`. Never
   reserve twice, and never deny work that was already accepted.

   Because rollover ran first, a surviving reservation is necessarily in the
   live window, so this can only ever replay an admission that is still valid.
   Revision 5 had these two steps the other way around, which silently undid
   `claim`'s expiry check: `claim` would detect the expired window, call
   `admit`, and `admit` would match the stale reservation and hand the same
   dead admission straight back. See Admission ordering.
3. **Sweep.** Delete `resv:*` whose `beat:*` is older than
   `reservation_stale_seconds`. Staleness is measured from the last heartbeat.
   A turn admitted but not yet started has no heartbeat, so treat its admission
   time as the first beat and allow `reservation_start_grace_seconds` before it
   is eligible.
4. **Admit or deny.** `committed = spent + sum(resv:*)`.
   - `spent >= budget` returns DENY with reason `limit_reached` and `reset_at`.
   - `committed >= budget` but `spent < budget` returns DENY with reason
     `concurrent_turns`. Budget remains; other turns are holding it. This is
     transient and retryable in seconds.
   - Otherwise write `resv:{turn_id}` and `beat:{turn_id}`, return ADMIT with
     `window_id` and `reset_at`.

### `claim` (at execution start)

Run at the point the turn actually begins, and always **before the response is
opened**. See Delivering a claim rejection.

Checks, in order:

1. **Expiry.** If `now >= reset_at`, the reservation belongs to a window that
   has ended, whether or not the key still exists. Re-run admission, which
   rolls the window over and judges the turn against the current one.
2. **Existence and identity.** If `resv:{turn_id}` is missing, or `window_id`
   does not match, re-run admission.
3. Otherwise refresh `beat:{turn_id}` and proceed. This is the normal path.

The expiry check is not redundant with existence. A key survives to
`expires_at`, so between `reset_at` and `expires_at` an old reservation is
still present under the old `window_id`, and nothing has rolled the window over
unless some other admission happened to run. Without step 1, a turn admitted at
14:55 could be claimed at 15:02 and charged against a window that was already
over, so the spend would land on a counter about to be discarded. That is rule
08 applied to `claim`: expiry is decided by `reset_at`, never by key presence.

This check only works because `admit` resolves rollover before it reads any
reservation. The two are a pair, and neither is sufficient alone. See Admission
ordering.

Once a turn is claimed it is never re-gated. From here on it always finishes.

### Admission ordering

The rule in one line: **nothing reads a reservation until expiry has been
resolved.**

Both `claim` and `admit` check `reset_at` before they look at `resv:*`, and
rollover deletes the whole key, so a reservation can never outlive the window
it was taken in. Read either operation on its own and the ordering looks like a
detail; together they are what stops a turn banking an admission in a window
that is about to be discarded.

### `heartbeat` (while the turn runs)

Set `beat:{turn_id} = now`, in one script, only if `window_id` matches **and**
`resv:{turn_id}` exists. Never create either field.

### `settle` (per `on_chat_model_end`)

1. **Check `window_id` first.** If it does not match the one issued at
   admission, or the key is gone, or admission was unenforced, do nothing at
   all. No debit, no field write, no key creation.
2. `SET seen:{run_id} NX PX <expires_at - now>`. The marker must outlive every
   settle that could still arrive for this window, and `expires_at` is exactly
   when the window's accounting ends. A fixed TTL would be wrong in both
   directions: too short lets a late replay double-charge, too long retains
   markers for windows that no longer exist. If the marker already existed,
   stop.
3. `HINCRBY spent <units>`. Leave the reservation alone.

**Units are integers.** `units = ceil(input_tokens + output_weight *
output_tokens)`, computed before the call. `output_weight` is a float, so the
product is fractional as soon as the weight is not 1.0, and `HINCRBY` takes
integers. Round up rather than to nearest, so a charge never rounds to zero and
the meter errs toward the budget. `HINCRBYFLOAT` is rejected deliberately:
`spent` is compared against `budget` in Lua on every admission, and keeping it
integral keeps those comparisons exact.

Settlement does not require the reservation to still exist. A turn swept
mid-flight still settles correctly.

### `release` (when the turn ends)

Delete `resv:{turn_id}` and `beat:{turn_id}` in one script, guarded on
`window_id`, and tolerate their absence. Call it from the `finally` in
`_start_claimed_turn` (`agentic.py:880`), beside the existing
`release_turn_lease`, so it runs on success, failure and cancellation alike.

## Admission is provisional

An earlier revision let a swept turn execute unreserved. That was a bypass, and
it did not require Redis to be unhealthy: a host could accept N messages across
N tabs, wait out `reservation_start_grace_seconds + reservation_stale_seconds`
so every reservation was swept, then start all N streams at once. All of them
would run with no reservation, defeating the concurrency bound and making the
worst-case overshoot grow with N instead of being capped at one turn per slot.

`claim` closes it. The rule is the distinction between two states:

- **Never started.** Re-gated at `claim`. Nothing has been generated, so a
  denial costs the host nothing but a retry, and the promise that answers
  finish is untouched.
- **Already started.** Protected. It heartbeats, and if a Redis blip sweeps it
  anyway it proceeds unreserved and still settles on `window_id`. This case
  cannot be accumulated on purpose, because it requires the turn to be really
  executing.

So a reservation can only be lost by a turn that is actively running, and a
turn that waits loses its admission instead.

## The correctness rules

1. **Admission and reservation are one atomic operation.** Checking `spent`
   before sending and debiting after would let several tabs walk through the
   same check together. The reservation is not a cost estimate. It is fixed
   occupancy, released and replaced by the real cost when the turn ends. Its
   job is bounding concurrency: `budget / reservation_units` is the most turns
   one host can have in flight.
2. **Occupancy lasts the whole turn.** Reserved at `admit`, freed at
   `release`, never at `settle`.
3. **Admission is provisional until `claim`.** Waiting out a reservation loses
   the admission; it does not buy an unmetered slot.
4. **A live turn is never reaped.** The sweep measures staleness from the last
   heartbeat, and both surfaces heartbeat for as long as they are producing
   output. This is the orphan-lock lesson from `server/AGENTS.md` section 5,
   applied to reservations.
5. **Dedupe keys on the model invocation, not the turn.** A reconnect or a
   replayed event carries the same `run_id` and is dropped. The
   context-overflow retry at `agentic_worker.py:504` really does call the model
   again, gets a new `run_id`, and is charged twice, which is correct.
6. **Attribution is by `window_id`, not by time.** Checked before any field is
   touched, in every operation.
7. **A denial says why.** `limit_reached` and `concurrent_turns` are different
   conditions with different remedies.
8. **Expiry is decided by `reset_at`, never by key presence.** The key outlives
   the window by `settle_grace`. Every reader compares `now` to `reset_at`.

## Where the code goes

| File | Change |
|---|---|
| `server/dembrane/chat_limit.py` | New. Scripts, resolver, the five operations, error helper |
| `server/dembrane/api/agentic.py:950` | `admit` |
| `server/dembrane/api/agentic.py:1033` | `admit` |
| `server/dembrane/api/chat.py:1112` | `admit` |
| `server/dembrane/api/agentic.py:2316` | `claim`, where the turn lease is acquired |
| `server/dembrane/api/chat.py:1253` | `claim`, before `raw_stream` is built |
| `server/dembrane/api/agentic.py:818` | `heartbeat`, inside the existing lease refresh loop |
| `server/dembrane/api/chat.py:1253` | `heartbeat`, a periodic task cancelled in `finally` |
| `server/dembrane/api/agentic.py:880` | `release`, in the existing `finally` |
| `server/dembrane/agentic_worker.py:276` | `settle`, in the `on_chat_model_end` branch |
| `server/dembrane/api/chat.py` | `settle` and `release` on the LiteLLM completion |
| `server/dembrane/api/chat.py` | `GET` status endpoint |
| `server/dembrane/settings.py` | Config fields below |
| `directus/` | Nullable `chat_token_budget_override` on `billing_account` |
| `frontend/src/lib/chatLimit.ts` | New, beside `freeTier.ts` |
| Chat composer | Warning, blocked and retryable states |

The Directus column is created by an idempotent API script, then pulled into
the snapshot. Never hand-write the snapshot JSON. See the Directus rules in
`AGENTS.md`.

## Budget resolution

Resolved **once, when the window is born**, and frozen into the hash with the
accounting policy. One read per window, so roughly one per host per five hours.

Freezing is what makes "one host, one budget" true. Without it, a host working
across two workspaces on different accounts would see the ceiling move when
they switched projects, mid-window.

Which value gets frozen is the open question. See Open, item 1.

Per-account escape hatch: `billing_account.chat_token_budget_override`,
nullable. Support raises one customer's budget from the Directus admin UI, no
deploy. It applies to windows born after the change, by design.

## Config

Fields on `AppSettings` in `settings.py`, set through gitops:

- `chat_limit_window_seconds` (default 18000)
- `chat_limit_budget_*` (pending item 1)
- `chat_limit_reservation_units`
- `chat_limit_heartbeat_interval_seconds`
- `chat_limit_reservation_stale_seconds` (several heartbeat intervals)
- `chat_limit_reservation_start_grace_seconds`
- `chat_limit_settle_grace_seconds`
- `chat_limit_warn_ratio` (default 0.8)
- `chat_limit_output_weight` (default 1.0)

`chat_limit_output_weight` meters raw total tokens at 1.0 today. Output tokens
cost several times input, so this lets you weight them later without touching
the schema. It only works because analytics records input and output
separately from day one. See the rounding rule in `settle`.

Frozen fields, and `settle_grace`, affect windows born afterwards. The sweep
timings take effect immediately. See What is frozen.

Config removals are release-gated. See
`docs/incidents/gitops-env-removal-release-gate.md`.

## Error contract

429, not 402. Waiting is free, so "payment required" would be dishonest, and
`api/rate_limit.py` already returns 429 for the same shape of refusal. Send
`Retry-After` too: seconds until `reset_at` for `limit_reached`, a few seconds
for `concurrent_turns`.

```json
{
  "detail": {
    "error": "CHAT_USAGE_LIMIT",
    "reason": "limit_reached",
    "reset_at": "2026-09-18T15:00:00Z",
    "window_seconds": 18000
  }
}
```

`reason` is `limit_reached` or `concurrent_turns`.

### Delivering a claim rejection

A denial at `claim` uses the same body, but only if it can still be sent as a
response. Once a streaming response is open its status and headers are gone, so
`claim` must run **before the response is constructed** on both surfaces:

| Surface | Where `claim` runs | Why it is safe there |
|---|---|---|
| Agentic | `stream_run`, at the lease acquisition (`agentic.py:2316`) | Inside the `status == "queued"` branch, which precedes the `StreamingResponse` return |
| Legacy chat | The endpoint body, immediately before `raw_stream` is built (`chat.py:1253`) | `stream_response_async` is only instantiated there; its body runs after the response opens |

An earlier revision placed the legacy `claim` at `chat.py:1207`, inside the
generator. That is after the response has opened, where a 429 is impossible.
The check belongs above `headers`, beside the other pre-response work.

For agentic there is a second consumer to satisfy: a client attached to the run
from elsewhere is not the one receiving this 429. On a claim denial the run is
also marked failed through the existing `build_run_failure_payload` path, so
every attached client learns through the error channel it already handles.
No new stream event type is needed.

Frontend: leave `src/lib/freeTier.ts` alone. Add `chatLimit.ts` exporting
`isChatLimitError`, reusing the same `extractDetail` shape. The upgrade modal
must never be reachable from a cooldown.

## Status endpoint

`GET` returning `{ state, spent, budget, reset_at, warn_ratio }` where `state`
is `ok`, `warning` or `blocked`.

Three rules, each of which is a way the composer could otherwise stay stuck:

1. **Read-only. It must never open a window.** Opening one on a page load
   would start the clock on someone who never sent a message.
2. **An expired window reads as empty.** The key survives until `expires_at`,
   so a status read that trusted key presence would keep reporting `blocked`
   past the reset, exactly when the frontend rechecks. Compare `now` to
   `reset_at`, and when it has passed return the full budget with a null
   `reset_at`.
3. **On Redis failure it returns `ok`** with the full budget and a null
   `reset_at`, matching admission's fail-open. Returning an error or a stale
   `blocked` would leave a previously blocked composer with no way back.

When there is no window at all, it returns the full budget and a null
`reset_at`.

The frontend calls it:

- on page load, so the warning state survives a refresh
- after each completed turn, to refresh the remaining budget
- once at `reset_at`, to clear a blocked composer without a manual reload

A `concurrent_turns` denial does not disable the composer. It shows a
transient retry affordance and clears when an in-flight turn finishes. Only
`limit_reached` disables until reset.

## What the host sees

Nothing at all while there is room.

Past `warn_ratio`, a quiet inline notice with the reset time. At
`limit_reached`, the composer disables with the reset time. On
`concurrent_turns`, a brief retry notice, no disabling. No always-on gauge.

Copy follows `brand/STYLE_GUIDE.md`: no em dashes, never "AI", sentence case.
Something like "You have reached your chat limit. It resets at 15:00."

## Analytics

One PostHog event per turn via `capture_event` in `analytics.py`, plus one per
blocked attempt.

Fields: `user_id`, `window_id`, `turn_id`, `input_tokens`, `output_tokens`,
`total_tokens`, `charged_units`, `applied_budget`, `applied_output_weight`,
`window_seconds`, `percent_of_budget`, `turn_duration_ms`, `tier`, and the
`estimated`, `late` and `unenforced` flags. Blocked attempts also carry
`reason` and whether they were blocked at `admit` or at `claim`.

`charged_units` is the rounded integer actually debited, recorded alongside the
raw token counts so a retune can tell the difference between what was spent and
what was charged.

`applied_output_weight` and `window_seconds` are the frozen values from the
window, not the current config, or a retune would be computed against settings
that were not in force at the time.

The input and output split is not optional. `chat_limit_output_weight` cannot
be tuned later from a combined total.

This is an audit trail, **not enforcement state**. It cannot rebuild the
counter: capture is fire-and-forget and `analytics.py` opts out entirely
outside production and echo-next.

## Failure behaviour

**Every quota operation fails open.** Admission, claim, heartbeat, settlement,
release and status reads all swallow Redis errors. Accounting must never
interrupt an answer or fail a request.

**Every one of them logs a warning on failure**, and admission additionally
emits `chat_limit_unenforced`. Settlement and heartbeat failures matter for
diagnosis: repeated settle failures mean spend is vanishing from enforcement
while chat looks healthy.

**An unenforced admission issues no `window_id`.** It returns an explicit
sentinel. If Redis recovers mid-turn, that turn's settles find no `window_id`
and debit nothing, so they cannot charge an unrelated window that was born in
the meantime. The turn's spend is lost from enforcement and recorded in
analytics with `unenforced: true`.

The reasoning behind fail-open is narrower than it first appears:

- Agentic chat is already dead without Redis. `acquire_turn_lease` at
  `agentic.py:2316` is unguarded inside `stream_run`, so the request 500s, and
  both event publishing and the client stream are Redis pub/sub. Failing
  closed there would cost nothing.
- Legacy project chat has **no Redis dependency at all**
  (`grep -n redis server/dembrane/api/chat.py` is empty). It keeps working
  through a full Redis outage. Failing closed there would be a self-inflicted
  outage on a healthy surface.

So fail-open does real work for exactly one surface, and it is the surface
being retired. When legacy chat goes, revisit this.

### Accepted consequences

Two different failure modes, with different exposure. Only the first is
bounded.

- **A restart or flush** loses the counters. Every host gets one fresh window.
  Exposure is bounded by `window_seconds`.
- **A sustained outage** makes admission fail open for as long as it lasts.
  Limits are unenforced for the duration of the outage, which is **not
  bounded** by `window_seconds` or anything else in this design. This is
  accepted, and it is the reason `chat_limit_unenforced` must be alerted on
  rather than merely logged.

Also accepted:

- Analytics events cannot recover the counter. Recoverable state would mean a
  Directus ledger, deliberately not built.
- Valkey defaults to RDB snapshots with `stop-writes-on-bgsave-error`. A full
  disk makes it refuse writes while still serving reads, so admission raises
  and chat silently goes unmetered. This is the sustained case above, reached
  without the server ever going down. A real `MISCONF` of this kind is on
  record in `docs/troubleshooting-tips.md`.

## Tests

- `admit` under concurrency: N parallel calls against a budget that fits fewer
  reserve exactly `budget / reservation_units` and deny the rest with
  `concurrent_turns`.
- **The delayed-turn bypass:** N turns admitted, all reservations allowed to be
  swept, then all started at once. `claim` re-gates each one, and only
  `budget / reservation_units` of them proceed.
- `claim` on a live reservation refreshes the beat and does not re-reserve.
- **Regression, admission ordering.** The full path, with the old reservation
  deliberately left in place: admit a turn into window A, advance past
  `reset_at` but not past `expires_at` so the key and `resv:{turn_id}` both
  still exist, then `claim`. Assert a new `window_id`, `spent` back at zero,
  the old `resv:*` gone, and the turn judged against the new window's budget.
  Asserting only that `claim` re-ran `admit` passes against the rev 5 bug;
  the assertion has to be on the window the turn ends up in.
- A turn re-admitted this way is denied if the new window is already full,
  rather than inheriting its old acceptance.
- A claim denial on legacy chat returns 429 with no partial body, proving the
  check ran before the response opened.
- A claim denial on agentic marks the run failed, so a separately attached
  client sees the error.
- A claimed turn is never re-gated afterwards, even once the window fills.
- The legacy heartbeat keeps beating while no chunks arrive: a turn stalled in
  router retries longer than `reservation_stale_seconds` is not swept.
- A turn swept mid-flight keeps running, `heartbeat` does not recreate the
  reservation, and `settle` still debits.
- A turn that makes several model calls keeps its reservation until `release`.
- Both surfaces heartbeat: an agentic turn and a legacy streaming turn each
  survive longer than `reservation_stale_seconds` without being swept, and the
  heartbeat task is cancelled once the turn ends.
- `release` on an already-swept turn is a no-op, not an error.
- Window birth sets the TTL once. A second message does not move `reset_at`.
- Rollover clears old `resv:*`, so a stale reservation cannot eat the new
  budget.
- Re-admitting the same `turn_id` while its reservation exists returns the
  original admission and reserves nothing further.
- Replaying the same `run_id` debits once. A new `run_id` debits again.
- The dedupe marker outlives the window: a settle replayed just before
  `expires_at` still does not double-charge.
- Weighted rounding: `output_weight = 1.5` on a turn with odd token counts
  debits a whole number, rounded up, and `spent` stays integral.
- A settle carrying a stale `window_id` debits nothing, writes nothing and
  creates no key.
- `spent >= budget` denies `limit_reached`; reservations alone deny
  `concurrent_turns`.
- Status never creates a window.
- Status past `reset_at` but before `expires_at` reads as empty, not blocked.
- Status with Redis down returns `ok` and the full budget.
- A live window keeps its frozen budget, output weight and expiry when config
  changes. A sweep timing change takes effect immediately.
- Redis down: `admit` admits with the unenforced sentinel and emits
  `chat_limit_unenforced`; a later settle with a recovered Redis debits
  nothing.
- Budget resolution, once item 1 is settled.

Tests run in the devcontainer, not on the host.

## Open

1. **Tier ownership.** A host can span workspaces on different billing
   accounts, so "which budget" is genuinely ambiguous. The mechanism is
   settled: whatever value is chosen is resolved once and frozen for the
   window's life. The choice is not. Candidates: one global host budget
   (simplest, drops tier as a lever), or the highest tier among the host's
   accounts (keeps per-tier budgets, needs a resolver).
2. **Production Valkey persistence.** `echo-gitops/` is gitignored and not
   cloned here, so this could not be checked. Without persistence every restart
   hands everyone a fresh window.
3. **`chat_limit_reservation_units`.** Sets max concurrent turns per host.
   Needs a real number from usage data.
4. **The 80th-percentile budget**, and confirmation it is raw total tokens.
