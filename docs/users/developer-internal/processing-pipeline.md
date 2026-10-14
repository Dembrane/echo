---
title: The processing pipeline
description: What happens between an uploaded audio chunk and a finished, summarised conversation. Four durable workflows on the Postgres queue, their steps and retries, and the media app that does the audio work.
audience: developer-internal
---

# The processing pipeline

The pipeline is four durable workflows on the Postgres job queue. Each side effect is a step whose result is checkpointed, so a run that crashes resumes at its first unfinished step on any worker. The audio work (convert, split, merge) is done by the `media` app, not by the worker.

The code is in `dembrane/platform/packages/conversations/src/pipeline/`: `defs.ts` (the jobs), `workflows.ts` (the step order and retries), `steps.ts` (what each step does) and `worker.ts` (registration and schedules).

## From upload to chunk

1. The client asks for an upload URL: `POST /api/participant/conversations/:conversation_id/get-upload-url`. The answer is a presigned form upload, with a limit of 2 GB per file and one hour to finish.
2. The client uploads the bytes straight to object storage.
3. The client confirms with `POST .../confirm-upload`. The API checks that the object exists and that the key is the one it issued for this conversation and chunk.
4. `createChunk` inserts the `conversation_chunk` row and enqueues the `conversations.chunk` workflow in the same transaction. A chunk never exists without its processing.

Typed text goes in through `POST .../upload-text`. It creates a chunk that already has a transcript, so no audio processing runs.

If audio arrives for a conversation that was already finished and finalized, the conversation is reset: not finished, no summary, no merged audio. The next finish processes everything again.

The request and response fields are on the [participant API](../developer-external/participant-api.md) page.

## The four workflows

| Job name | Trigger | Steps | Runs at once per worker |
|---|---|---|---|
| `conversations.chunk` | A new audio chunk | `load`, `prepare`, `transcribe` for each piece, `hand-over` | 20 |
| `conversations.finish` | The finish call, or the idle sweep | `claim`, `stamp-over-cap`, `hand-over` | 10 |
| `conversations.finalize` | Hand-over, when the conversation is finished and nothing is pending | `claim`, `merge`, `summarize`, `summarized-webhook`, `token-count`, `measure` | 10 |
| `conversations.summarize` | The summary catch-up | `summarize`, `summarized-webhook` | 5 |

Chunk runs wait on the language model, so many run at once. The ffmpeg work they hand to the media app scales there.

### What each step does

| Step | What it does |
|---|---|
| `prepare` | A file that is not mp3 is converted to mp3 by the media app. A file above 15 MB is cut into pieces of equal duration. Bad bytes (too small, too large, or rejected by ffprobe) mark the chunk "Audio not playable" and the run moves on. |
| `transcribe` | One Gemini call per piece on the `multi_modal_pro` model group, with the audio sent inline. On a retryable error it falls back to `multi_modal_fast`. The project's `language` and its key terms (`default_conversation_transcript_prompt`) are passed in. The result is stored in `conversation_chunk.transcript`, with `diarization.schema` set to `Dembrane-26-07-gemini`. |
| `hand-over` | The one place that decides a conversation is ready. It locks the conversation row, checks that the conversation is finished and that no chunk is pending, and enqueues `conversations.finalize` in the same transaction. Both the chunk run and the finish run call it, so whichever commits last sees the other's work. |
| `claim` in finish | Sets `is_finished`. Of two finishes at the same time, exactly one proceeds. |
| `stamp-over-cap` | Sets `is_over_cap` from the workspace's recorded hours and its tier. |
| `claim` in finalize | Sets `is_all_chunks_transcribed` once, and queues the `conversation.transcribed` webhooks in the same commit. |
| `merge` | Joins every chunk with audio, in time order, into one mp3. Sets `merged_audio_path` and `duration`. If the merge gives up, the merged file is built on demand when a host plays the conversation. |
| `summarize` | One model call on `multi_modal_pro`. A conversation locked by its tier is skipped, and is summarised after an upgrade. Then `summarized-webhook` queues the `conversation.summarized` webhook. |
| `measure` | Fills `duration` by probing chunks when the merge left none. |

When the project anonymises transcripts, transcription also redacts. A regular-expression pass replaces emails, IBANs, phone numbers, Dutch postcodes and 8 to 9 digit numbers with placeholders. A second model pass then corrects and redacts, using the audio and the first transcript.

Accepted audio formats are aac, wav, mp3, ogg, flac, webm, opus, m4a, mp4 and mpeg (`ACCEPTED_AUDIO_FORMATS` in `packages/audio/src/formats.ts`).

### The flags to trust

| Flag | Set by | Means |
|---|---|---|
| `conversation.is_finished` | The finish claim | No more audio is expected. |
| `conversation.is_all_chunks_transcribed` | The finalize claim | Every chunk has a transcript or an error. |
| `conversation_chunk.error` | Prepare or transcribe | This chunk is done and has no usable transcript. |

A chunk is pending while it has no transcript and no error. A chunk with a saved error counts as done, so one bad chunk does not block the conversation.

Each finished or failed step writes a row to `processing_status`. The dashboard's processing timeline reads those rows.

## Retries

Retries belong to the steps, not to the job. `RETRIES` in `workflows.ts` holds the values.

| Kind of step | Attempts | First wait | Backoff |
|---|---|---|---|
| Transcribe | 6 | 30 s | doubling |
| Media (ffmpeg) | 8 | 15 s | doubling |
| Model call (summary) | 6 | 15 s | doubling |
| Database | 5 | 2 s | doubling |

- A recoverable transcription failure (no speech, bad audio, truncated output) is saved on the chunk as its `error` and the run moves on. Other failures retry and are saved only on the last attempt.
- One run is bounded at 6 hours for chunk and finalize, and 1 hour for finish and summarize.
- Every step is written so that it is safe to run twice. Keep that property when you change one.
- Changing the order or number of steps in a workflow needs a bump of `WORKFLOW_VERSION`. See [background jobs and schedules](./background-jobs-and-scheduler.md).

## The media app

The media app is an HTTP shell around ffmpeg: `POST /probe`, `/probe-url`, `/convert`, `/split`, `/merge`, and `GET /health`. The ffmpeg code itself lives in `packages/audio`.

- It has no database, no bucket credentials and no secrets. Callers hand it presigned URLs to read from and write to.
- It runs one conversion at a time per instance.
- The worker's pipeline calls it over HTTP. The API calls it for an upload's duration and for merged audio downloads.
- It runs apart from the API and the worker because audio conversion is CPU-heavy native work. A crash there ends one conversion, not the API or the worker.
- When `MEDIA_URL` is unset, the same code runs ffmpeg inside the calling process. Then ffmpeg must be on the `PATH` of the API and the worker. This is how local development works.

## Schedules that keep it moving

| Job name | Every | What it does |
|---|---|---|
| `conversations.finish-idle` | 2 minutes | Finishes conversations nobody added to for 5 minutes. A conversation with no chunks at all waits 30 minutes, and stays open while the portal still pings. |
| `conversations.summary-catch-up` | 5 minutes | Summarises transcribed conversations that have no summary and are not locked. |

## Reports and chat

- A report is one durable workflow, `reports.generate`, in `packages/reports/src/jobs.ts`. A worker runs 4 at once. The prompt budget is `REPORT_MAX_CONTEXT_TOKENS`.
- Chat replies are streamed by the API. An assistant turn runs in the worker as the `agentic.turn` job. See [chat and the assistant](./chat-and-agent.md).

## Models

Features ask for a model group, never a vendor model name. The groups are `text_fast`, `multi_modal_fast` and `multi_modal_pro`, and each is an ordered list of Vertex model ids with fallback in that order. The `llm` package holds the logic. [Configuration and language model providers](../developer-external/configuration-and-llm-providers.md) covers the settings.

## Related

- [Background jobs and schedules](./background-jobs-and-scheduler.md)
- [The data model](./data-model.md)
- [Chat and the assistant](./chat-and-agent.md)
- [Participant API](../developer-external/participant-api.md)
- [Webhooks](../developer-external/webhooks.md)
- [Transcription](../../features/transcription.md)
