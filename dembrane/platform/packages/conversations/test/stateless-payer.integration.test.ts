import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Access } from "@dembrane/access";
import type { Media } from "@dembrane/audio";
import { createDb } from "@dembrane/db";
import { type Payer, payer } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { FakeTranscriber, type TranscribeInput } from "@dembrane/transcription";
import postgres from "postgres";
import { AudioUrls } from "../src/audio-urls";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { transcribeStateless } from "../src/stateless/service";
import { admin, freshDatabase, PROJECT, quiet } from "./pipeline-harness";

// POST /api/stateless/transcribe names its project in the form, out of the middleware's sight.
const run = admin ? describe : describe.skip;

class PayerTranscriber extends FakeTranscriber {
  readonly payers: (Payer | undefined)[] = [];
  override transcribe(input: TranscribeInput) {
    this.payers.push(payer());
    return super.transcribe(input);
  }
}

run("stateless transcription payer", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let d: ConversationsDeps;
  const transcriber = new PayerTranscriber();

  beforeAll(async () => {
    const url = await freshDatabase("conv_stateless_payer_test");
    database = createDb({ url, poolMax: 2 });
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed) values (${PROJECT}, 'P', 'en', true)`;
    await sql.end();
    d = {
      db: database.db,
      access: { project: async () => ({}) } as unknown as Access,
      audio: new FilesystemStorage(
        mkdtempSync(join(tmpdir(), "stateless-payer-")),
        "http://t",
        "/a",
      ),
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      jobs: { enqueue: async () => null },
      models: {} as ConversationsDeps["models"],
      media: { probeUrl: async () => ({ format: { duration: "3" } }) } as unknown as Media,
      transcriber,
      hub: null,
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("s".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: false,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      now: () => new Date(),
    };
  });
  afterAll(async () => {
    await database?.close();
  });

  const note = (projectId: string | null) =>
    transcribeStateless(
      d,
      { appUserId: "a", directusUserId: "u", isStaff: true },
      {
        projectId,
        workspaceId: null,
        budgetExempt: false,
        file: new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }),
        audioFileUri: null,
        language: "en",
        hotwords: null,
        usePiiRedaction: false,
        anonymizeTranscripts: false,
        customGuidancePrompt: null,
        promptOverride: null,
      },
      { gate: async () => {}, checkFile: () => {} },
    );

  test("a voice note is billed to the project it names, or internally without one", async () => {
    await note(PROJECT);
    await note(null);
    expect(transcriber.payers).toEqual([
      { ref: "project", id: PROJECT },
      { internal: "voice_without_project" },
    ]);
  });
});
