#!/usr/bin/env bun
/**
 * Prompt comparison pack (ECHO-1052): for each transcript, every Verify topic and every
 * Explore mode, the payload the model got before this change (OLD) and the one it gets now
 * (NEW), side by side, so a person can judge them. Nothing here touches a database.
 *
 *   bun packages/verify/test/prompt-pack/run.ts --out <dir>
 *       payloads only: no model, no credentials
 *   bun packages/verify/test/prompt-pack/run.ts --out <dir> --run
 *       also asks Vertex multi_modal_pro for each payload and writes its answer beside it;
 *       needs Google application default credentials (gcloud auth application-default login)
 *       and LLM_VERTEX_PROJECT / LLM_VERTEX_LOCATION / LLM_MULTI_MODAL_PRO like the platform
 *
 * OLD is rendered from the templates at --old-ref (default origin/main, read with git show)
 * and the topic texts in src/previous-defaults.ts, assembled as the code before ECHO-1052
 * did (participant name and email in the Verify message, other tables by name in Explore).
 * NEW is rendered by the shipped functions: generationInput and replyPrompt.
 *
 * Transcripts: platform/demos/example-en/fixture.json (English, five tables of one event)
 * and the six synthetic Dutch tables in ./transcripts.ts. Explore in OLD read the other
 * conversations' summaries; these have none, so the first three lines of each stand in.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CURRENT_CONVERSATION_NAME,
  formatConversation,
  OTHER_CONVERSATION_NAME,
  replyPrompt,
} from "@dembrane/conversations";
import { renderPromptSource } from "@dembrane/prompts";
import { DEFAULT_TOPICS, defaultTopicPrompt } from "../../src/defaults";
import { PREVIOUS_TOPICS } from "../../src/previous-defaults";
import { generationInput } from "../../src/service";
import { DUTCH_CONVERSATIONS, DUTCH_PROJECT, type PackConversation } from "./transcripts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const out = arg("--out");
if (!out) throw new Error("--out <dir> is required");
const oldRef = arg("--old-ref") ?? "origin/main";
const run = process.argv.includes("--run");

const here = path.dirname(new URL(import.meta.url).pathname);
const platform = path.resolve(here, "../../../..");
const repo = path.resolve(platform, "../..");

/** A template file as it was at oldRef. */
function oldTemplate(name: string): string {
  return execFileSync(
    "git",
    ["show", `${oldRef}:dembrane/platform/packages/prompts/templates/${name}`],
    { cwd: repo, encoding: "utf8" },
  );
}

interface PackProject {
  readonly slug: string;
  readonly name: string;
  readonly language: string;
  readonly context: string;
  readonly keyTerms: string | null;
  readonly templateKey: string | null;
  readonly conversations: readonly PackConversation[];
}

const fixture = JSON.parse(
  readFileSync(path.join(platform, "demos/example-en/fixture.json"), "utf8"),
) as {
  organisation: string;
  event: string;
  title: string;
  language: string;
  conversations: { id: string; label: string; theme: string; transcript: string }[];
};

const PROJECTS: readonly PackProject[] = [
  {
    slug: "en-fixture",
    name: `${fixture.organisation} ${fixture.event}`,
    language: fixture.language,
    context: `${fixture.title} A synthetic event of the fictional ${fixture.organisation}.`,
    keyTerms: null,
    templateKey: "event",
    conversations: fixture.conversations.map((c) => ({
      id: c.id,
      participantName: c.label,
      participantEmail: null,
      what: c.theme,
      transcript: c.transcript,
    })),
  },
  {
    slug: "nl-synthetic",
    name: DUTCH_PROJECT.name,
    language: DUTCH_PROJECT.language,
    context: DUTCH_PROJECT.context,
    keyTerms: DUTCH_PROJECT.keyTerms,
    templateKey: DUTCH_PROJECT.templateKey,
    conversations: DUTCH_CONVERSATIONS,
  },
];

const summaryOf = (c: PackConversation) => c.transcript.split("\n").slice(0, 3).join("\n");

// ── OLD, as the code before ECHO-1052 assembled it ─────────────────────

function oldVerify(p: PackProject, c: PackConversation, topicPrompt: string) {
  const system = renderPromptSource(oldTemplate("generate_artifact.en.jinja"), {
    prompt: topicPrompt,
    language: p.language || "en",
    pii_redaction: false,
  });
  const lines = [`Project: ${p.name}`, `Conversation ID: ${c.id}`];
  if (c.participantName) lines.push(`Participant name: ${c.participantName}`);
  if (c.participantEmail) lines.push(`Participant email: ${c.participantEmail}`);
  lines.push(
    "",
    "Previous artifacts: None\n",
    "Conversation transcript:",
    c.transcript,
    "",
    "Audio attachments: None.",
  );
  return { system, user: lines.join("\n") };
}

function oldExplore(p: PackProject, c: PackConversation, mode: "summarize" | "brainstorm") {
  const lang = p.language;
  const file = (n: string) => {
    try {
      return oldTemplate(`${n}.${lang}.jinja`);
    } catch {
      return oldTemplate(`${n}.en.jinja`);
    }
  };
  const description = [p.context];
  if (p.keyTerms) description.push(`Default Conversation Transcript Prompt: ${p.keyTerms}`);
  const others = p.conversations
    .filter((o) => o.id !== c.id)
    .map((o) => formatConversation({ name: o.participantName, tags: [], transcript: summaryOf(o) }))
    .join("");
  return {
    user: renderPromptSource(file("get_reply_system"), {
      PROJECT_DESCRIPTION: description.join("\n\n"),
      GLOBAL_PROMPT: renderPromptSource(file(`get_reply_${mode}`), {}),
      OTHER_TRANSCRIPTS: others,
      MAIN_USER_TRANSCRIPT: formatConversation({
        name: c.participantName,
        tags: [],
        transcript: `${c.transcript}\n`,
      }),
      pii_redaction: false,
    }),
  };
}

// ── NEW, by the shipped functions ──────────────────────────────────────

function newVerify(p: PackProject, c: PackConversation, key: string) {
  const topic = DEFAULT_TOPICS.find((t) => t.key === key);
  if (!topic) throw new Error(key);
  const input = generationInput({
    project: {
      id: p.slug,
      name: p.name,
      language: p.language,
      context: p.context,
      default_conversation_transcript_prompt: p.keyTerms,
      anonymize_transcripts: false,
      template_key: p.templateKey,
    },
    conversationId: c.id,
    topicPrompt: defaultTopicPrompt(key, topic.prompt, p.language) ?? topic.prompt,
    artifacts: [],
    transcript: c.transcript,
    audio: [],
  });
  return { system: input.system, user: input.text };
}

function newExplore(
  p: PackProject,
  c: PackConversation,
  mode: "summarize" | "brainstorm",
  crossPollination: boolean,
) {
  const others = crossPollination
    ? p.conversations
        .filter((o) => o.id !== c.id)
        .map((o) =>
          formatConversation({ name: OTHER_CONVERSATION_NAME, tags: [], transcript: summaryOf(o) }),
        )
        .join("")
    : "";
  return {
    user: replyPrompt({
      project: {
        context: p.context,
        default_conversation_title: null,
        default_conversation_description: null,
        default_conversation_transcript_prompt: p.keyTerms,
        get_reply_mode: mode,
        get_reply_prompt: null,
        anonymize_transcripts: false,
      },
      language: p.language,
      current: { name: CURRENT_CONVERSATION_NAME, tags: [], transcript: `${c.transcript}\n` },
      others,
    }),
  };
}

// ── writing, and optionally asking the model ───────────────────────────

type Payload = { system?: string; user: string };

const asText = (p: Payload) =>
  `${p.system ? `=== SYSTEM ===\n${p.system}\n\n` : ""}=== USER ===\n${p.user}\n`;

let ask: ((p: Payload) => Promise<string>) | null = null;
if (run) {
  const { createModels } = await import("@dembrane/llm");
  const { generateText } = await import("ai");
  const { withPayer } = await import("@dembrane/observability");
  const env = process.env;
  const pro = (env.LLM_MULTI_MODAL_PRO ?? "gemini-3.7-pro")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const models = createModels({
    vertexProject: env.LLM_VERTEX_PROJECT ?? "dembrane-web-previews",
    vertexLocation: env.LLM_VERTEX_LOCATION ?? "eu",
    groups: { text_fast: pro, multi_modal_fast: pro, multi_modal_pro: pro },
    embeddingModel: "text-embedding-005",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  });
  ask = (p) =>
    withPayer({ ref: "workspace", id: "prompt-pack" }, async () => {
      const { text } = await generateText({
        model: models.model("multi_modal_pro"),
        ...(p.system && { system: p.system }),
        messages: [{ role: "user", content: [{ type: "text", text: p.user }] }],
      });
      return text;
    });
}

const index: string[] = [
  "# Prompt comparison pack (ECHO-1052)",
  "",
  `OLD: templates at ${oldRef}, topic texts from previous-defaults.ts. NEW: this branch.`,
  run
    ? "Answers: generated with Vertex multi_modal_pro (*.answer.txt)."
    : "Answers: not generated (no --run). Payloads only.",
  "",
];

async function write(dir: string, name: string, payload: Payload | null) {
  if (!payload) return;
  writeFileSync(path.join(dir, `${name}.txt`), asText(payload));
  if (ask) writeFileSync(path.join(dir, `${name}.answer.txt`), `${await ask(payload)}\n`);
}

for (const p of PROJECTS) {
  index.push(`## ${p.slug}: ${p.name} (${p.language})`, "");
  for (const c of p.conversations) {
    const dir = path.join(out, p.slug, c.id);
    mkdirSync(dir, { recursive: true });
    index.push(`- ${p.slug}/${c.id}: ${c.what}`);
    for (const topic of DEFAULT_TOPICS) {
      const previous = PREVIOUS_TOPICS.find((t) => t.key === topic.key);
      await write(
        dir,
        `verify-${topic.key}.old`,
        previous ? oldVerify(p, c, previous.prompt) : null,
      );
      await write(dir, `verify-${topic.key}.new`, newVerify(p, c, topic.key));
    }
    for (const mode of ["summarize", "brainstorm"] as const) {
      await write(dir, `explore-${mode}.old`, oldExplore(p, c, mode));
      await write(dir, `explore-${mode}.new`, newExplore(p, c, mode, false));
      await write(dir, `explore-${mode}.new-cross-pollination`, newExplore(p, c, mode, true));
    }
  }
  index.push("");
}
index.push(
  "Per conversation: verify-<topic>.old.txt / .new.txt (heard is new, so it has no .old),",
  "explore-<mode>.old.txt / .new.txt (cross-pollination off, the default) /",
  ".new-cross-pollination.txt (on). summarize is the mode hosts see as Default, now One question.",
  "",
);
writeFileSync(path.join(out, "README.md"), `${index.join("\n")}\n`);
process.stdout.write(`wrote the pack to ${out}${run ? " with answers" : " (payloads only)"}\n`);
