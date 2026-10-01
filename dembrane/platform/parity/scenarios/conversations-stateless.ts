import { projects } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

// Stateless transcription. The parity stack has no object store and no transcription
// credentials, so only the gates and validation compare here; the transcribe, probe,
// clean-up and metering path is covered by packages/conversations/test/stateless.
const { p1, p2 } = projects;
const S = "/api/stateless/transcribe";
const audio = (type = "audio/webm", base64 = Buffer.from("audio-bytes").toString("base64")) => ({
  filename: "note.webm",
  type,
  base64,
});

export default scenarios([
  {
    name: "stateless webhook: removed",
    as: "anonymous",
    method: "POST",
    path: "/api/stateless/webhook/transcribe",
    body: { event: "done" },
    removed: "the retired transcription provider's callback, which only logged and ignored",
  },
  {
    name: "stateless: anonymous",
    as: "anonymous",
    method: "POST",
    path: S,
    form: { project_id: p1 },
  },
  {
    name: "stateless: unknown purpose",
    as: "alice",
    method: "POST",
    path: S,
    form: { purpose: "free_lunch", project_id: p1 },
  },
  { name: "stateless: project required", as: "alice", method: "POST", path: S, form: {} },
  {
    name: "stateless: purpose without input",
    as: "alice",
    method: "POST",
    path: S,
    form: { purpose: "pricing_intake" },
  },
  {
    name: "stateless: staff without project or input",
    as: "admin",
    method: "POST",
    path: S,
    form: {},
  },
  {
    name: "stateless: both inputs",
    as: "alice",
    method: "POST",
    path: S,
    form: { project_id: p1, audio_file_uri: "x.mp3", file: audio() },
  },
  {
    name: "stateless: empty file",
    as: "alice",
    method: "POST",
    path: S,
    form: { project_id: p1, file: audio("audio/webm", "") },
  },
  {
    name: "stateless: content type refused",
    as: "alice",
    method: "POST",
    path: S,
    form: { project_id: p1, file: audio("image/png") },
  },
  {
    name: "stateless: form validation",
    as: "alice",
    method: "POST",
    path: S,
    form: { project_id: p1, use_pii_redaction: "maybe", anonymize_transcripts: "sure" },
  },
  {
    name: "stateless: other tenant's project",
    as: "bob",
    method: "POST",
    path: S,
    form: { project_id: p1, file: audio() },
  },
  {
    name: "stateless: observer refused",
    as: "rita",
    method: "POST",
    path: S,
    form: { project_id: p2, file: audio() },
    setup: [P2_OPEN],
  },
  {
    name: "stateless: never onboarded",
    as: "dave",
    method: "POST",
    path: S,
    form: { project_id: p1, file: audio() },
  },
  {
    name: "stateless: a URL is not an input",
    as: "alice",
    method: "POST",
    path: S,
    form: { project_id: p1, audio_file_uri: "http://127.0.0.1:9/elsewhere.mp3" },
    differs: "H-6: full URLs were fetched server-side; only this project's stored audio is read",
  },
  {
    name: "stateless: another tenant's key",
    as: "alice",
    method: "POST",
    path: S,
    form: {
      project_id: p1,
      audio_file_uri: `conversation/c1000000-0000-4000-8000-000000000003/chunks/x.mp3`,
    },
    differs: "H-6: any bucket key was read; only keys of this project's conversations are",
  },
]);
