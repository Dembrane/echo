# signals

The record AI improvement reads from. Every model call is logged with the prompt version
that made it, every human verdict on its output is logged against the same artefact, and
only data whose client and participant both agreed can leave for training.

```
 model call ──► model_call (metering)  + step, prompt_ref, prompt_version,
     │                                    target_type + target_id of the artefact
     ▼
 artefact ───► person acts ──► ai_signal   accept · edit (before/after) · revise · reject · rate
                                   │
                                   ▼
                        trainableSignals()  client opted in AND participant consented
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
             eval cases per step          training pairs (RSI)
                    └──────► new prompt or model version ──► back to the top
```

## What is here

| Piece | Where |
|---|---|
| Call trace: what a call is for, carried in `providerOptions.dembrane` and stripped before the provider sees it | `llm/src/trace.ts`, `CompletionRequest.trace`, `withTrace()` for direct AI SDK calls |
| The trace on every metered call: five columns on `model_call`, which metering already writes for every attempt | `ModelCall.trace`, `metering` `toRow()` |
| A version for every Jinja prompt: the first 12 hex digits of its SHA-256 | `prompts` `templateVersion()` |
| `ai_signal`: what a person did with an artefact | `recordSignal()`, `classifyEdit()` |
| Training consent: `ai_training` on workspace and project (project overrides), `training_consent_at` and `training_consent_version` on conversation | `trainingVerdict()` |
| The one way signals leave for training | `trainableSignals()`, `bun run signals:export -- --out x.jsonl` |

`model_call` stores no text and no people's ids, only the artefact's id; the output stays in
the artefact's own table. `ai_signal` cascades from `project` and `conversation`, so erasure
removes it with the conversation.

## Steps wired so far

| Step | Call traced | Signal |
|---|---|---|
| Verify (participant outcomes) | `verify.generate`, `verify.revise` | accept, edit (model text kept as `before`), revise |
| Everything else | metered with its operation, no trace yet | none yet |

## Consent rule

A signal is trainable only if the client opted in (the project's `ai_training`, else the
workspace's, else no) and the participant consented on that conversation. A deleted
conversation never is. Nothing sets these fields yet; until the settings and the portal
checkbox exist, `signals:export` returns nothing, which is the intended default.

## Next

1. Consent UI: the workspace and project setting next to legal basis, and the portal
   checkbox that writes `training_consent_at` and `_version`. The portal cards that say data
   "is not used to train AI models" change only for opted-in projects.
2. Trace the remaining callers (chat, agentic, reports, summaries, titles, tags,
   transcription, map, popcorn, canvas): one `trace` per call site.
3. Write signals from the feedback that already exists: chat thumbs
   (`model_response_feedback`), `analysis_feedback`, authored analysis revisions, report and
   canvas edits, title, summary and tag overwrites. Host signals carry `actor_id`, so they
   join the user privacy export and erasure in `staff` in the same change.
4. Evals per step on the popcorn eval's pattern, with cases built from accepted and edited
   artefacts, scored per `prompt_version`.
5. An optimiser that proposes a new prompt version from edit pairs, runs the step's eval and
   opens a pull request.
