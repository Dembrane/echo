import { durationOf } from "@dembrane/audio";
import { newId, type PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/http";
import { TranscriptionError } from "@dembrane/transcription";
import { and, eq } from "drizzle-orm";
import type { ConversationsDeps } from "../deps";
import { isUuid } from "../storage";

// Uploaded audio is parked under this prefix only for the duration of the request.
const UPLOAD_PREFIX = "stateless-transcription";
const SIGNED_URL_SECONDS = 3600;
// conversation.source has no constraint; this marks the metering rows.
const SOURCE = "STATELESS_TRANSCRIPTION";
const PARTICIPANT = "Voice note";

export interface StatelessInput {
  readonly projectId: string | null;
  readonly file: File | null;
  readonly audioFileUri: string | null;
  readonly language: string | null;
  readonly hotwords: string | null;
  readonly usePiiRedaction: boolean;
  readonly anonymizeTranscripts: boolean;
  readonly customGuidancePrompt: string | null;
  readonly promptOverride: string | null;
}

export interface StatelessHooks {
  /** Who may call without a project: a purpose (rate limited) or staff. */
  gate(): Promise<void>;
  /** Content type and size of an uploaded file. */
  checkFile(file: File): void;
  fail(status: number, message: string): PlatformError;
}

function parseHotwords(raw: string | null): string[] | null {
  if (!raw) return null;
  const words = raw
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  return words.length ? words : null;
}

/** A parked upload's key keeps a short, safe extension so the container stays detectable. */
function uploadKey(filename: string): string {
  const ext = (/\.[^./]*$/.exec(filename)?.[0] ?? "").toLowerCase();
  return `${UPLOAD_PREFIX}/${newId()}${/^\.[a-z0-9]{1,9}$/.test(ext) ? ext : ""}`;
}

/**
 * H-6: a caller-named input must be a stored chunk of the project being billed. The
 * Python API fetched any URL server-side and read any bucket key, other tenants' audio
 * included.
 */
async function ownedKey(
  d: ConversationsDeps,
  input: StatelessInput,
  fail: StatelessHooks["fail"],
): Promise<string> {
  const uri = input.audioFileUri as string;
  if (/^https?:\/\//i.test(uri.trim()))
    throw fail(400, "audio_file_uri must be a storage key of this project's audio, not a URL");
  let key: string;
  try {
    key = d.audioUrls.keyOf(uri);
  } catch (err) {
    throw fail(400, (err as Error).message);
  }
  const cid = /^conversation\/([^/]+)\//.exec(key)?.[1];
  const { conversation } = schema;
  const owned =
    input.projectId && isUuid(cid)
      ? await d.db
          .select({ id: conversation.id })
          .from(conversation)
          .where(and(eq(conversation.id, cid), eq(conversation.project_id, input.projectId)))
          .limit(1)
      : [];
  if (!owned.length)
    throw fail(400, "audio_file_uri must be a storage key of this project's audio");
  return key;
}

/**
 * The Dembrane-26-07 pipeline on one input, then a conversation row born deleted that
 * meters its duration against the project (billing counts deleted rows; listings do not).
 */
export async function transcribeStateless(
  d: ConversationsDeps,
  who: Signed,
  input: StatelessInput,
  hooks: StatelessHooks,
): Promise<{ transcript: string; note: string }> {
  // Writing access, not reading: this spends the workspace's audio hours (Q H-14: staff
  // act through their own workspace role, as everywhere on the platform).
  if (input.projectId) await projectFor(d.access, who, input.projectId, "project:update");
  else await hooks.gate();
  if ((input.file === null) === (input.audioFileUri === null))
    throw hooks.fail(400, "Provide exactly one of file or audio_file_uri");
  if (input.file) hooks.checkFile(input.file);

  let parked: string | null = null;
  let key: string;
  let audio: Uint8Array;
  if (input.file) {
    key = uploadKey(input.file.name);
    audio = new Uint8Array(await input.file.arrayBuffer());
    await d.audio.put(key, audio, input.file.type || undefined);
    parked = key;
  } else {
    key = await ownedKey(d, input, hooks.fail);
    const blob = await d.audio.get(key);
    if (!blob) throw hooks.fail(400, `Audio not found: ${key}`);
    audio = new Uint8Array(await blob.arrayBuffer());
  }

  let transcript: string;
  let note: string;
  let duration: number | null = null;
  try {
    try {
      const r = await d.transcriber.transcribe({
        audio,
        language: input.language,
        hotwords: parseHotwords(input.hotwords),
        usePiiRedaction: input.usePiiRedaction,
        anonymizeTranscripts: input.anonymizeTranscripts,
        customGuidancePrompt: input.customGuidancePrompt,
        promptOverride: input.promptOverride,
      });
      transcript = r.transcript;
      note = r.note;
    } catch (err) {
      if (err instanceof TranscriptionError) throw hooks.fail(502, err.message);
      throw err;
    }
    // After transcription, so a probe failure never costs the caller a transcript. A
    // missing duration is recorded as unknown, never as a made-up zero.
    try {
      const url = d.audio.presignDownload(key, { expiresInSeconds: SIGNED_URL_SECONDS });
      const seconds = durationOf(await d.media.probeUrl(url));
      duration = seconds !== null && seconds > 0 ? seconds : null;
    } catch (err) {
      d.logger.error({ err }, "failed to probe audio duration for stateless transcription");
    }
  } finally {
    // Stateless means no residue, whether transcription worked or not.
    if (parked)
      await d.audio
        .delete(parked)
        .catch((err) => d.logger.error({ err }, "stateless cleanup failed"));
  }

  if (input.projectId) {
    if (duration === null)
      d.logger.error(
        { project: input.projectId, signal: "stateless.unmetered_duration" },
        "metering a stateless transcription with no duration",
      );
    try {
      const now = d.now().toISOString();
      await d.db.insert(schema.conversation).values({
        id: newId(),
        project_id: input.projectId,
        participant_name: PARTICIPANT,
        source: SOURCE,
        duration,
        is_finished: true,
        deleted_at: now,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      // The caller did the work and gets the transcript; a lost row is ours to fix.
      d.logger.error({ err, project: input.projectId }, "failed to meter stateless transcription");
    }
  }
  return { transcript, note: note || "" };
}
