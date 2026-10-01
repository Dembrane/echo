import { AudioError } from "./errors";

export const ACCEPTED_AUDIO_FORMATS = [
  "aac",
  "wav",
  "mp3",
  "ogg",
  "flac",
  "webm",
  "opus",
  "m4a",
  "mp4",
  "mpeg",
] as const;
export type AudioFormat = (typeof ACCEPTED_AUDIO_FORMATS)[number];

export const isAudioFormat = (v: string): v is AudioFormat =>
  (ACCEPTED_AUDIO_FORMATS as readonly string[]).includes(v);

/** get_file_format_from_file_path: the extension, if it is an accepted audio format. */
export function fileFormatOf(path: string): AudioFormat {
  const ext = (path.toLowerCase().split(".").pop() ?? "").split("?")[0] ?? "";
  if (isAudioFormat(ext)) return ext;
  throw new AudioError("value", `Unsupported file type: ${path}`);
}

const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mp3",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  opus: "audio/opus",
  m4a: "audio/m4a",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
};

export function mimeTypeOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const m = MIME[ext];
  if (!m) throw new AudioError("value", `Unsupported file type: ${path}`);
  return m;
}

/** Files above this are split before transcription (audio_utils.MAX_CHUNK_SIZE). */
export const MAX_CHUNK_BYTES = 15 * 1024 * 1024;
