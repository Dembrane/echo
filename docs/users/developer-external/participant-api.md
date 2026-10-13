---
title: The participant API
description: The endpoints the participant portal records through. Start a conversation, upload audio or text, finish, and what you can and cannot rely on.
audience: developer-external
---

# The participant API

These are the endpoints dembrane's own portal uses to record a conversation into a project. A participant has no account, so none of them needs a sign-in. If you build your own recorder or kiosk, this is what you call.

> [!IMPORTANT]
> What you can rely on: dembrane's own portal depends on these paths, bodies and error codes, and v3 kept them for that reason. What you cannot rely on: they are not declared a public contract. There is no version to pin and no reference beyond this page. Other routes the portal and the dashboard call, such as those under `/api/v2/bff/*`, are internal.

The API allows cross-origin browser calls from the dashboard and the portal only. A recorder that runs in a browser on your own domain cannot call the hosted API directly. Call it from a server or a native app.

## The flow

```text
GET  /api/participant/projects/:project_id                          the project's portal settings
POST /api/participant/projects/:project_id/conversations/initiate   a conversation and its token
for each piece of audio:
  POST /api/participant/conversations/:conversation_id/get-upload-url
  POST <upload_url>                                                 the bytes, straight to storage
  POST /api/participant/conversations/:conversation_id/confirm-upload
POST /api/participant/conversations/:conversation_id/finish
```

### 1. Start a conversation

```http
POST /api/participant/projects/:project_id/conversations/initiate
Content-Type: application/json

{ "name": "Group 3", "pin": "" }
```

- `name` and `pin` are required strings. The handler does not read `pin`: send an empty string, as the portal does.
- Optional: `email`, `user_agent`, `tag_id_list`, `source`, `visitor_id`. A tag is attached only when it belongs to the project.

The response body is the conversation. The response header `x-participant-token` carries the token for this conversation.

### 2. Keep the token

Send the token back in the `x-participant-token` request header on every later call for this conversation. A call with a wrong token is refused with `403` and the code `participant.token_invalid`.

### 3. Upload audio

Ask for an upload URL:

```http
POST /api/participant/conversations/:conversation_id/get-upload-url
Content-Type: application/json

{ "filename": "chunk-1.webm", "content_type": "audio/webm", "conversation_id": "<conversation id>" }
```

The answer has `chunk_id`, `upload_url`, `fields` and `file_url`. This is a presigned form upload, not a presigned PUT. Send a form POST to `upload_url`: add every entry of `fields` first, then the file in a field named `file`, last.

Then confirm the upload:

```http
POST /api/participant/conversations/:conversation_id/confirm-upload
Content-Type: application/json

{ "chunk_id": "<chunk_id>", "file_url": "<file_url>", "timestamp": "2026-10-13T09:30:00Z" }
```

`file_url` must be the one you were given for this conversation and chunk. An optional `source` defaults to `PORTAL_AUDIO`. Confirming creates the chunk and starts its transcription.

### 4. Or send typed text

```http
POST /api/participant/conversations/:conversation_id/upload-text
Content-Type: application/json

{ "timestamp": "2026-10-13T09:30:00Z", "content": "What the participant typed." }
```

An optional `source` defaults to `PORTAL_TEXT`. The text becomes a chunk that already has its transcript.

### 5. Finish

```http
POST /api/participant/conversations/:conversation_id/finish
```

When the conversation is finished and every chunk is transcribed, dembrane merges the audio and writes the summary. A conversation that gets no new chunk for 5 minutes is finished automatically. Audio that arrives after that reopens the conversation, and the next finish processes it again.

To follow the result, subscribe to [webhooks](./webhooks.md) for `conversation.transcribed` and `conversation.summarized`.

## Limits

| Limit | Value |
|---|---|
| Upload URLs | 40 per minute per conversation |
| File size | 2 GB per file |
| Time to finish one upload | 1 hour |
| Audio formats | aac, wav, mp3, ogg, flac, webm, opus, m4a, mp4, mpeg |
| Participant replies | 20 per minute per conversation |
| Report subscriptions | 20 per 10 minutes per address |

- `get-upload-url` answers `500` with the code `upload.url_failed` when the rate limit is hit and when the project is closed. It does not answer `429`.
- A file under 1024 bytes is kept as a chunk marked "Audio not playable".
- A project that is closed to new conversations refuses the other participant calls with `403` and the code `conversation.not_open`.

## All the endpoints

| Method and path | What it does |
|---|---|
| `GET /api/participant/projects/:project_id` | The portal settings of an open project: language, tags, portal texts, the verify and reply switches, legal basis, privacy policy URL, organiser name, logo. |
| `POST /api/participant/projects/:project_id/conversations/initiate` | Starts a conversation and returns the token. |
| `GET /api/participant/projects/:project_id/conversations/:conversation_id` | The participant's view of the conversation. |
| `GET /api/participant/projects/:project_id/conversations/:conversation_id/chunks` | The conversation's chunks, newest first. |
| `GET /api/participant/projects/:project_id/conversations/:conversation_id/replies` | Replies under the conversation. |
| `DELETE /api/participant/projects/:project_id/conversations/:conversation_id/chunks/:chunk_id` | Removes one chunk. |
| `POST /api/participant/conversations/:conversation_id/check-s3` | Returns `probe_url`, a presigned URL the portal tries before recording to learn that storage is reachable. |
| `POST /api/participant/conversations/:conversation_id/get-upload-url` | A presigned form upload for one new chunk. |
| `POST /api/participant/conversations/:conversation_id/confirm-upload` | Confirms the upload and creates the chunk. |
| `POST /api/participant/conversations/:conversation_id/upload-text` | Adds typed text. |
| `POST /api/participant/conversations/:conversation_id/finish` | The finish signal. |
| `POST /api/participant/conversations/:conversation_id/ping` | A liveness ping for the host's live monitor. |
| `POST /api/conversations/:conversation_id/get-reply` | Streams a reply to the participant. Body: `language`. |
| `GET /api/participant/:project_id/report/latest` and the other `/api/participant/.../report/...` routes | The participant's report, its views and metrics, subscribe and unsubscribe. |

There is no multipart `upload-chunk` route. Audio goes through the presigned upload only.

## Related

- [Authentication](./authentication.md)
- [Webhooks](./webhooks.md)
- [Portal & participant experience](../../features/portal-and-participant-experience.md)
- [Portal editor](../../features/portal-editor.md)
- [The processing pipeline](../developer-internal/processing-pipeline.md)
