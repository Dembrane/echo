#!/usr/bin/env bun
/**
 * Quality check for setup suggestions: prints what each fixture would be proposed, and what
 * the rules dropped and why.
 *
 *   bun packages/projects/test/setup-quality/run.ts          fake model (no credentials)
 *   bun packages/projects/test/setup-quality/run.ts --real   Vertex text_fast, needs credentials
 *
 * The fake model is deliberately naive and over-eager: every capitalised phrase, every
 * abbreviation, a few common words and two invented names. What survives shows the rules
 * at work; it says nothing about how good the real model's picks are.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Completer, createModels, vertexCompleter } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { projectTemplate } from "../../src/project-templates";
import { askSetupModel, type ModelAnswer } from "../../src/setup/model";
import { cleanKeyTerms, MAX_KEY_TERMS } from "../../src/setup/rules";
import { cleanSettings, PROPOSABLE_FIELDS, templateValue } from "../../src/setup/settings";
import { FIXTURES, type QualityFixture } from "./fixtures";

const real = process.argv.includes("--real");

function hasCredentials(): boolean {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) return existsSync(file);
  return existsSync(path.join(homedir(), ".config/gcloud/application_default_credentials.json"));
}

/** text_fast on Vertex, named as the platform config names it (LLM_* variables). */
function realCompleter(): Completer {
  const env = process.env;
  const fast = (env.LLM_TEXT_FAST ?? "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const groups = { text_fast: fast, multi_modal_fast: fast, multi_modal_pro: fast };
  const models = createModels({
    vertexProject: env.LLM_VERTEX_PROJECT ?? "dembrane-web-previews",
    vertexLocation: env.LLM_VERTEX_LOCATION ?? "eu",
    groups,
    embeddingModel: "text-embedding-005",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  });
  return vertexCompleter(models, { groups });
}

const JOIN = new Set(["van", "de", "der", "den", "op", "aan", "of", "the", "and", "in"]);

/** Every capitalised phrase and abbreviation, plus noise a careless model would add. */
function naiveAnswer(f: QualityFixture): ModelAnswer {
  const text = `${f.name}\n${f.description}\n${f.source_text}`;
  const phrases: string[] = [];
  // Clause by clause, so a phrase never runs across a full stop, a comma or a bracket.
  for (const clause of text.split(/[\n.,:;()"]+/)) {
    let run: string[] = [];
    const flush = () => {
      while (run.length && JOIN.has(run[run.length - 1] as string)) run.pop();
      if (run.length) phrases.push(run.join(" "));
      run = [];
    };
    for (const t of clause.split(/[\s/]+/).filter(Boolean)) {
      if (/^\p{Lu}/u.test(t)) run.push(t);
      else if (run.length && JOIN.has(t)) run.push(t);
      else flush();
    }
    flush();
  }
  const noise = ["Philips", "Arno van der Berg", "bewoners", "warmtenet", "meeting", "Agenda"];
  const terms = [...new Set([...phrases, ...noise])].map((term) => ({
    term,
    reason: "Named in what you wrote.",
  }));
  const settings: ModelAnswer["settings"] = [];
  const tables = /(\d+)\s*(tafels|tables)/i.exec(text);
  if (tables) {
    settings.push({
      field: "default_conversation_ask_for_participant_name",
      value: "true",
      reason: `You mention ${tables[1]} tables, so each one names itself.`,
    });
    settings.push({
      field: "is_verify_enabled",
      value: "true",
      reason: "Tables sign off together.",
    });
  }
  if (/bevestig|agree/i.test(text)) {
    settings.push({
      field: "is_verify_enabled",
      value: "true",
      reason: "You want outcomes confirmed.",
    });
    settings.push({
      field: "is_verify_on_finish_enabled",
      value: "true",
      reason: "A reminder at the end.",
    });
  }
  settings.push({ field: "anonymize_transcripts", value: "true", reason: "never allowed" });
  return { key_terms: terms, settings };
}

const completer = real ? (hasCredentials() ? realCompleter() : null) : null;
if (real && !completer) {
  process.stderr.write("--real needs Vertex credentials; none found.\n");
  process.exit(2);
}
process.stdout.write(
  `setup suggestions quality check: ${real ? "REAL model (text_fast)" : "FAKE naive model, real-model quality unverified"}\n`,
);

for (const f of FIXTURES) {
  const template = projectTemplate(f.template_key);
  const answer = completer
    ? await withPayer({ internal: "setup_quality_check" }, () =>
        askSetupModel(completer, {
          templateKey: f.template_key,
          templateFacts: Object.fromEntries(
            PROPOSABLE_FIELDS.map((k) => [k, templateValue(template, k)]),
          ),
          name: f.name,
          description: f.description,
          sourceText: f.source_text,
          pageText: "",
          existingTerms: f.existing_key_terms,
          language: f.language,
          includeSettings: true,
        }),
      )
    : naiveAnswer(f);
  if (!answer) {
    process.stdout.write(`\n## ${f.id}: no usable answer\n`);
    continue;
  }
  const { terms, dropped } = cleanKeyTerms(answer.key_terms, {
    sources: { description: `${f.name}\n${f.description}`, text: f.source_text },
    existing: f.existing_key_terms,
    language: f.language,
  });
  const settings = cleanSettings(answer.settings, template);
  process.stdout.write(`\n## ${f.id} (${f.template_key}, ${f.language})\n`);
  process.stdout.write(
    `proposed ${terms.length} of ${MAX_KEY_TERMS - f.existing_key_terms.length} room: ${terms.map((t) => `${t.term} [${t.source}]`).join(" | ")}\n`,
  );
  const byWhy = new Map<string, string[]>();
  for (const d of dropped) byWhy.set(d.why, [...(byWhy.get(d.why) ?? []), d.term]);
  for (const [why, list] of byWhy) process.stdout.write(`dropped ${why}: ${list.join(" | ")}\n`);
  process.stdout.write(
    `settings: ${settings.map((s) => `${s.field} ${String(s.current)} -> ${String(s.proposed)} (${s.reason})`).join("; ") || "none"}\n`,
  );
}
