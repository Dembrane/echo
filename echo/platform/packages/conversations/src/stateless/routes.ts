import { ForbiddenError, PlatformError, ValidationError } from "@echo/core";
import { type Env, requireUser } from "@echo/http";
import { type Issue, p } from "@echo/legacy-shape";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";
import { type StatelessInput, transcribeStateless } from "./service";

const { str, bool, nullable } = p;

/** A status with the Python API's detail text, for the few codes @echo/core does not name. */
class StatusError extends PlatformError {
  readonly code = "stateless";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The one purposes a caller may name to transcribe without a project to bill.
const UNMETERED = ["pricing_intake", "issue_report"] as const;
// Tighter than any form's own ceiling: this spends transcription, not a row.
const PURPOSE_LIMITS = {
  pricing_intake: { name: "pricing_intake_transcription", capacity: 30, windowSeconds: 3600 },
  issue_report: { name: "issue_report_transcription", capacity: 30, windowSeconds: 3600 },
} as const;

const MAX_BYTES = 100 * 1024 * 1024;
// webm/mp4 recordings often carry a video/* type; octet-stream covers clients that set none.
const ALLOWED_TYPES = ["audio/", "video/", "application/octet-stream"];

const formShape = {
  project_id: nullable(str()),
  purpose: nullable(str()),
  audio_file_uri: nullable(str()),
  language: nullable(str()),
  hotwords: nullable(str()),
  use_pii_redaction: bool(),
  anonymize_transcripts: bool(),
  custom_guidance_prompt: nullable(str()),
  prompt_override: nullable(str()),
};

/**
 * The declared Content-Type of a multipart part. Bun's form parser replaces it with a
 * type guessed from the file name; the content-type check reads what the client sent,
 * as Starlette's UploadFile.content_type did.
 */
function partType(raw: Uint8Array, contentType: string, field: string): string | null {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return null;
  // Part headers are ASCII; latin1 keeps byte offsets and never throws on binary bodies.
  const text = Buffer.from(raw).toString("latin1");
  for (const part of text.split(`--${boundary}`)) {
    const head = part.slice(0, part.indexOf("\r\n\r\n"));
    if (new RegExp(`name="${field}"`, "i").test(head))
      return /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? null;
  }
  return null;
}

/** The form fields, checked as FastAPI checked Form(...) parameters (422 at ["body", name]). */
async function readForm(req: Request) {
  let form: FormData | null = null;
  let fileType: string | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (/multipart\/form-data|x-www-form-urlencoded/.test(ct)) {
    const raw = new Uint8Array(await req.arrayBuffer());
    form = (await new Response(raw, { headers: { "content-type": ct } })
      .formData()
      .catch(() => null)) as FormData | null;
    fileType = partType(raw, ct, "file");
  }
  const issues: Issue[] = [];
  const values: Record<string, unknown> = {};
  let file: File | null = null;
  for (const [key, type] of Object.entries(formShape)) {
    const raw = form?.get(key);
    if (raw === null || raw === undefined) continue;
    const v = typeof raw === "string" ? raw : null;
    const r = type.parse(v, ["body", key], issues);
    if (typeof r !== "symbol") values[key] = r;
  }
  const f = form?.get("file");
  if (f instanceof File) file = new File([f], f.name, { type: fileType ?? f.type });
  if (issues.length) throw new ValidationError("Request validation failed", issues as never);
  return {
    file,
    project_id: (values.project_id as string | null | undefined) ?? null,
    purpose: (values.purpose as string | null | undefined) ?? null,
    audio_file_uri: (values.audio_file_uri as string | null | undefined) ?? null,
    language: values.language === undefined ? "en" : (values.language as string | null),
    hotwords: (values.hotwords as string | null | undefined) ?? null,
    use_pii_redaction: (values.use_pii_redaction as boolean | undefined) ?? false,
    anonymize_transcripts: (values.anonymize_transcripts as boolean | undefined) ?? false,
    custom_guidance_prompt: (values.custom_guidance_prompt as string | null | undefined) ?? null,
    prompt_override: (values.prompt_override as string | null | undefined) ?? null,
  };
}

/**
 * POST /api/stateless/transcribe: one audio input transcribed synchronously, nothing but
 * a metering row kept. POST /api/stateless/webhook/transcribe: the retired provider's
 * callback, accepted and ignored.
 */
export function statelessRoutes(d: ConversationsDeps) {
  const app = new Hono<Env>();

  app.post("/api/stateless/webhook/transcribe", async (c) => {
    await p.validate(c.req, { body: p.dict() });
    d.logger.info("transcription webhook received but integration is disabled; ignoring payload");
    return c.json(null);
  });

  app.post("/api/stateless/transcribe", async (c) => {
    const who = requireUser(c);
    const f = await readForm(c.req.raw);
    if (f.purpose !== null && !(UNMETERED as readonly string[]).includes(f.purpose))
      throw new StatusError(422, `Unsupported purpose: ${f.purpose}`);
    const purpose = f.purpose as (typeof UNMETERED)[number] | null;
    const input: StatelessInput = {
      projectId: f.project_id,
      file: f.file,
      audioFileUri: f.audio_file_uri,
      language: f.language,
      hotwords: f.hotwords,
      usePiiRedaction: f.use_pii_redaction,
      anonymizeTranscripts: f.anonymize_transcripts,
      customGuidancePrompt: f.custom_guidance_prompt,
      promptOverride: f.prompt_override,
    };
    return c.json(
      await transcribeStateless(d, who, input, {
        async gate() {
          // A project to bill wins over a purpose; a purpose alone is rate limited per
          // person; staff alone may name neither.
          if (input.projectId) return;
          if (purpose) await d.limiter.check(PURPOSE_LIMITS[purpose], who.directusUserId);
          else if (!who.isStaff) throw new ForbiddenError("project_id is required");
        },
        checkFile(file) {
          if (file.type && !ALLOWED_TYPES.some((t) => file.type.startsWith(t)))
            throw new StatusError(400, `Unsupported content type: ${file.type}`);
          if (file.size === 0) throw new StatusError(400, "Uploaded file is empty");
          if (file.size > MAX_BYTES)
            throw new StatusError(413, `File size exceeds ${MAX_BYTES / 1024 / 1024}MB limit`);
        },
        fail: (status, message) => new StatusError(status, message),
      }),
    );
  });

  return app;
}
