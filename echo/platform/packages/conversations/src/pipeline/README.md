# Conversation pipeline

Participant audio cannot be collected twice, so the pipeline's job is to never lose a
chunk and never leave a conversation half done. It runs as four DBOS workflows (ADR 0007).
Each side effect is a step; DBOS checkpoints a step's result in Postgres, and after a
crash the run resumes on any worker at its first unfinished step. A step can still run
twice (a crash after its effect, before its checkpoint), so every step below is safe to
repeat. This replaces the Python saga (process, transcribe, finish, finalize, merge and
summarise as separate Dramatiq actors, Redis counters and locks between them) and the
crons that repaired it.

## Runs

| Workflow | Started by | Run id |
|---|---|---|
| `conversations.chunk` | a chunk with audio is created (portal upload, confirm-upload, retranscribe), in the same transaction as the row | `conversations.chunk:<chunk id>`: a second start is the same run |
| `conversations.finish` | the portal's finish, or the idle sweep | singleton per conversation while queued or running |
| `conversations.finalize` | the hand-over, in the transaction that decided it | `conversations.finalize:<conversation>:<hash of its chunk ids>`: the same state joins one run; more audio after a reopen gets a new one |
| `conversations.summarize` | the summary catch-up | singleton per conversation |

## Steps and why each is safe to repeat

`conversations.chunk`
1. **load**: reads the chunk and its conversation. Read only. A chunk that is gone, or
   already has a transcript or an error (typed text, an unplayable upload), skips to
   the hand-over.
2. **prepare**: converts to mp3 on the media service and splits files over 15 MB. The mp3
   key derives from the original key and is overwritten on a retry; the path update
   writes the same value; piece ids are UUIDv5 of the chunk id and index, piece keys
   derive from them, piece rows are inserted `ON CONFLICT DO NOTHING` and the original
   is deleted in the same transaction; a retry that finds the original gone returns the
   pieces by their derived ids. Bad bytes mark the chunk `Audio not playable` (a write
   of a constant). Out of retries, the chunk is marked with the error, where the Python
   left it pending forever and its conversation never finalized.
3. **transcribe** (once per piece): Gemini on the piece, then one update of that chunk's
   transcript and diarization (and the conversation's token count cleared). A repeat
   overwrites the row with a transcript of the same audio. Every failure is saved on the
   chunk; recoverable ones (no speech, rejected audio, truncated output) end the step
   normally, others retry five times from 30 s. Out of retries, the saved error is what
   makes the chunk count as done.
4. **hand-over**: with the conversation row locked, if it is finished and no chunk is
   pending, queues the finalize run in the same transaction. Enqueueing the same run id
   twice is one run.

`conversations.finish`
1. **claim**: `is_finished = true` only where it was not, so of two finishes one proceeds
   and a repeat of the step changes nothing.
2. **stamp-over-cap**: ADR 0001's soft-edge formula from the workspace's lifetime hours;
   the same database state writes the same value.
3. **hand-over**: as above. Finish and the last chunk both lock the row, so whichever
   commits second sees the other; the Python's version of this race is why
   `task_reconcile_transcribed_flag` existed.

`conversations.finalize`
1. **claim**: under the row lock, `is_all_chunks_transcribed` flips once and the
   `conversation.transcribed` webhooks are queued in the same commit. A repeat finds the
   flag set and stops the run.
2. **merge**: every chunk's audio into `audio-conversations/merged-<id>-<run>.mp3` on
   the media service, then `merged_audio_path` and `duration`. The name derives from the
   run id, so a repeat overwrites its own file. No audio or only unreadable audio ends
   the step quietly; out of retries the run moves on (the dashboard's first play merges
   on demand).
3. **summarize**: skips a finished conversation that has a summary (so a repeat after
   the write is a no-op) and a tier-locked one. Out of retries it moves on; the catch-up
   tries again.
4. **summarized-webhook**: queues `conversation.summarized` when step 3 wrote a summary.
   At least once, as webhooks always were.
5. **token-count**: skips when the count is set; otherwise computes and stores it.

`conversations.summarize`: steps 3 and 4 of finalize.

## Schedules kept, and why

- `conversations.finish-idle` (every 2 minutes): finishes conversations nobody added to
  for five minutes. This is product behaviour (a participant who closes the tab), not a
  repair.
- `conversations.summary-catch-up` (every 5 minutes): summarises transcribed conversations
  without a summary that are not locked. A locked conversation summarises once its
  workspace upgrades; a summary that ran out of retries gets another chance.

Dropped: `task_reconcile_transcribed_flag` (the locked hand-over removes the race it
repaired), `task_catch_up_uncounted_conversations` (finalize counts, and readers compute
on demand), and the Redis coordination counters and locks (row locks and run ids).

## Processing status

Steps write `processing_status` rows with the Python event names
(`task_transcribe_chunk.completed`, `task_merge_conversation_chunks.failed`, ...), which
the dashboard's timeline reads. They are a log: a repeated step writes its row again.

## Changing a workflow

Changing the order or number of steps in a workflow bumps `WORKFLOW_VERSION` in
`packages/queue`, and in-flight runs of the old version are drained first (ADR 0007).

## Cutover

Conversations the Python saga left mid-way carry no run. A one-off pass after cutover
enqueues `conversations.finish` for unfinished conversations and `conversations.finalize`
for finished ones that are not transcribed; both are no-ops on conversations that are
already done.
