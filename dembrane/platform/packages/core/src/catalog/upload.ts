import type { Codes } from "./types";

export const upload = {
  "upload.file_not_found": {
    action: "none",
    detail: "File not found",
    description: "A stored file (avatar, logo) does not exist or the caller may not read it.",
  },
  "upload.too_large": {
    action: "fix_input",
    detail: "The file is larger than {max_mb} MB",
    description: "An uploaded file is over the size limit for its kind.",
  },
  "upload.unsupported_type": {
    action: "fix_input",
    detail: "Unsupported file type",
    params: ["accepted", "content_type"],
    description: "The file's type is not one this upload accepts.",
  },
  "upload.failed": {
    action: "retry",
    detail: "Upload failed",
    description: "The file did not reach storage; nothing was saved.",
  },
  "upload.empty": {
    action: "fix_input",
    detail: "Uploaded file is empty",
    description: "The uploaded file has no bytes.",
  },
  "upload.url_failed": {
    action: "retry",
    detail: "Failed to generate upload URL",
    description:
      "The portal could not get a presigned upload URL for a recording chunk (storage away or the chunk row failed); sent as a 500.",
  },
  "upload.probe_url_failed": {
    action: "retry",
    detail: "Failed to generate S3 probe URL",
    description: "The portal's storage reachability probe could not be presigned; sent as a 500.",
  },
  "upload.confirm_failed": {
    action: "retry",
    detail: "Failed to confirm upload",
    description:
      "Recording a finished chunk upload failed after the file reached storage; sent as a 500.",
  },
  "upload.wrong_conversation": {
    action: "none",
    detail: "File does not belong to this conversation",
    audience: "developer",
    description: "A confirm named a storage key outside the conversation's own prefix.",
  },
  "upload.unsupported_purpose": {
    action: "fix_input",
    detail: "Unsupported purpose: {purpose}",
    audience: "developer",
    description: "A stateless transcription named a purpose outside the unmetered list.",
  },
  "upload.project_required": {
    action: "fix_input",
    detail: "project_id is required",
    audience: "developer",
    description:
      "A stateless transcription named neither a project to bill nor a purpose, and the caller is not staff.",
  },
  "upload.source_ambiguous": {
    action: "fix_input",
    detail: "Provide exactly one of file or audio_file_uri",
    audience: "developer",
    description: "A stateless transcription sent both a file and a storage key, or neither.",
  },
  "upload.audio_key_invalid": {
    action: "fix_input",
    detail: "audio_file_uri must be a storage key of this project's audio",
    audience: "developer",
    description:
      "A stateless transcription named a URL, a malformed key, or a key outside the billed project's audio.",
  },
  "upload.audio_not_found": {
    action: "none",
    detail: "Audio not found: {key}",
    audience: "developer",
    description: "The storage key a stateless transcription named holds no object.",
  },
  "upload.transcription_failed": {
    action: "retry",
    detail: "Transcription failed",
    description:
      "The transcription model failed or answered something unreadable; sent as a 502 with the model's message.",
  },
} as const satisfies Codes<"upload">;
