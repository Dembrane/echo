---
title: The participant API
description: The unauthenticated endpoints the portal uses to record conversations - fetch project metadata, initiate a conversation, and upload audio or text.
audience: developer-external
---

# The participant API

The participant API is the set of *unauthenticated* endpoints that power the
[participant portal](../../features/portal-and-participant-experience.md). It's how someone can
scan a QR code or open a link, record a conversation, and have it land in your project - 
without ever creating an account. If you're building your own recorder or kiosk on top of
dembrane, this is the surface you'll use.

These routes live in `server/dembrane/api/participant.py` and are served under
`/api/participant/*` by the [FastAPI backend](./self-hosting.md) on port `8000`.

> [!NOTE]
> "Unauthenticated" means no user token is required - the project's identifier is the
> capability. Anyone with a project's public link can initiate and upload conversations to it,
> which is the point. Don't treat a project ID as a secret. Everything authenticated lives
> behind [Directus tokens](./authentication.md) instead.

## OpenAPI / interactive docs

Set `SERVE_API_DOCS=1` (see [configuration](./configuration-and-llm-providers.md#key-feature-toggles))
and the backend serves:

- `/docs` - the interactive Swagger UI explorer;
- `/redoc` - the ReDoc reference.

These render the live schema for your build, including request/response shapes for every
endpoint below. Keep them on while integrating; they're the authoritative parameter list.

## Reading public project data

Fetch the public metadata a recorder needs to render the start screen:

| Method & path | Returns |
|---|---|
| `GET /api/participant/projects/{pid}` | Public project metadata - title, language, the portal-editor configuration (welcome text, whether to ask for name/email, verification settings). |
| `GET /api/participant/projects/{pid}/conversations/{cid}` | A single conversation's public state. |
| `GET /api/participant/conversations/{cid}/chunks` | The chunks recorded so far for a conversation. |

The portal-editor fields returned here are what the [host configured](../../features/portal-editor.md)
for the participant experience.

## Initiating a conversation

Create a conversation to record into:

```http
POST /api/participant/conversations/initiate
Content-Type: application/json

{
  "project_id": "<pid>",
  "name": "Optional participant name",
  "email": "optional@example.org",
  "tag_id_list": ["<tag-id>", "..."],
  "source": "PORTAL_AUDIO"
}
```

Whether `name` and `email` are expected depends on the project's portal-editor settings (ask
for name / ask for email). The response carries the new conversation's ID, which you use for
every upload call that follows.

## The upload sequence

dembrane records in *chunks* (the portal uses ~30-second chunks). Each chunk goes to
S3-compatible storage via a presigned URL, then is confirmed so the backend can enqueue
transcription. The typical loop:

1. *Get a presigned upload URL.*
   ```http
   POST /api/participant/conversations/{cid}/get-upload-url
   ```
   Returns a presigned S3 URL (and the object key) to `PUT` the chunk to directly.
   > [!IMPORTANT]
   > This endpoint is *rate-limited to 40 requests per minute*. One presigned URL per chunk,
   > so a long recording made of short chunks will approach that ceiling - pace your requests.

2. *Upload the bytes* to the presigned URL (a direct `PUT` to S3/MinIO - this doesn't go
   through the dembrane backend, which is what keeps large uploads off the API).

3. *Confirm the upload* so the backend knows the chunk has landed and can process it:
   ```http
   POST /api/participant/conversations/{cid}/confirm-upload
   ```

Repeat 1–3 for each chunk as the recording proceeds.

### Alternatives to the presigned flow

- `POST /api/participant/conversations/{cid}/upload-chunk` - a *multipart* upload that
  sends the audio through the backend directly, for cases where a direct-to-S3 `PUT` isn't
  practical.
- `POST /api/participant/conversations/{cid}/upload-text` - submit *typed* text instead
  of audio (the portal's "type instead of speak" path).
- `POST /api/participant/conversations/{cid}/check-s3` - a connectivity check the portal
  runs to confirm the client can reach object storage before it starts recording. Use it to
  fail fast rather than discovering a broken upload mid-session.

## What happens after upload

Once chunks are confirmed, the [processing pipeline](../developer-internal/processing-pipeline.md)
takes over: each chunk is transcribed, corrected (key terms + redaction), and - when the
conversation is finished and all chunks are processed - merged and summarised. You can poll the
chunk and conversation endpoints to follow progress, and the host dashboard shows the same
state live. See [transcription](../../features/transcription.md) for what each stage does.

## Participant report endpoints

If the project enables a participant-facing report, the participant API also exposes endpoints
to fetch that report and its artifacts, and to unsubscribe from notifications. These back the
portal's *finish* and *report* screens; their exact shapes are in the `/docs` explorer for
your build. See [your report](../../features/portal-and-participant-experience.md) for the
participant-side view.

## A minimal end-to-end flow

```text
GET  /api/participant/projects/{pid}                      → render start screen
POST /api/participant/conversations/initiate              → conversation {cid}
loop while recording:
  POST /api/participant/conversations/{cid}/check-s3       → ok to upload?
  POST /api/participant/conversations/{cid}/get-upload-url → presigned URL  (≤ 40/min)
  PUT  <presigned-url>  (the chunk bytes)                  → straight to S3/MinIO
  POST /api/participant/conversations/{cid}/confirm-upload → enqueue processing
finish:
  (mark finished; fetch participant report if enabled)
```

## Related

- [The participant portal](../../features/portal-and-participant-experience.md) - what this API drives.
- [The portal editor](../../features/portal-editor.md) - the settings returned by the project endpoint.
- [Configuration & LLM providers](./configuration-and-llm-providers.md) - `SERVE_API_DOCS` and providers.
- [Authentication](./authentication.md) - for the *authenticated* surface.
- [Internal: the processing pipeline](../developer-internal/processing-pipeline.md) - what happens to a chunk.
