import { expect, test } from "bun:test";
import { ValidationError } from "@dembrane/core";
import {
  listProjectTemplates,
  PROJECT_TEMPLATE_KEYS,
  PROJECT_TEMPLATES,
  projectTemplate,
  templateColumns,
  templateTags,
} from "../src/project-templates";
import { PROJECT_UPDATE_FIELDS } from "../src/projects";

test("the registry holds the five templates, each once", () => {
  expect([...PROJECT_TEMPLATE_KEYS].sort() as string[]).toEqual(
    ["blank", "conversation", "event", "series", "upload"].sort(),
  );
});

test("a preset only sets fields the project PATCH accepts", () => {
  const allowed = new Set<string>(PROJECT_UPDATE_FIELDS);
  for (const t of PROJECT_TEMPLATES)
    for (const k of Object.keys(t.preset.fields))
      expect([t.key, allowed.has(k)]).toEqual([t.key, true]);
});

test("no preset touches what removes audio, decides the legal basis or is paid", () => {
  const never = [
    "anonymize_transcripts",
    "legal_basis",
    "privacy_policy_url",
    "is_dembrane_event_cta_enabled",
  ];
  for (const t of PROJECT_TEMPLATES)
    for (const lang of ["en", "nl", "cs"]) {
      const cols = templateColumns(t, lang);
      for (const k of never) expect([t.key, k, k in cols]).toEqual([t.key, k, false]);
    }
});

test("blank is the wizard's defaults and nothing else", () => {
  expect(templateColumns(projectTemplate("blank"), "en")).toEqual({
    is_conversation_allowed: true,
    default_conversation_ask_for_participant_name: true,
    default_conversation_tutorial_slug: "None",
    image_generation_model: "MODEST",
    template_key: "blank",
    template_version: 1,
  });
  expect(templateTags(projectTemplate("blank"), "en")).toEqual([]);
});

test("event asks for a table or group, seeds the rounds and turns on Verify and Explore", () => {
  const cols = templateColumns(projectTemplate("event"), "de");
  expect(cols).toMatchObject({
    default_conversation_ask_for_participant_name: true,
    conversation_ask_for_participant_name_label: "Name des Tisches oder der Gruppe",
    default_conversation_tutorial_slug: "advanced",
    is_verify_enabled: true,
    is_verify_on_finish_enabled: true,
    selected_verification_key_list: "agreements,actions,disagreements",
    is_get_reply_enabled: true,
    get_reply_mode: "summarize",
  });
  // Titles would pick round tags by themselves.
  expect(cols.enable_ai_title_and_tags).toBeUndefined();
  expect(templateTags(projectTemplate("event"), "de")).toEqual(["Runde 1", "Runde 2"]);
  expect(templateTags(projectTemplate("event"), "en-US")).toEqual(["Round 1", "Round 2"]);
  expect(templateTags(projectTemplate("event"), null)).toEqual(["Round 1", "Round 2"]);
});

test("an unknown key is a validation error naming the key", () => {
  let err: unknown;
  try {
    projectTemplate("festival");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).code).toBe("project.template_unknown");
  expect((err as ValidationError).params?.template_key).toBe("festival");
});

test("the list says what each template sets up, from its preset", () => {
  const byKey = Object.fromEntries(listProjectTemplates().templates.map((t) => [t.key, t]));
  expect(byKey.upload?.landing).toBe("upload");
  expect(byKey.event?.summary).toEqual({
    asks_for_name: true,
    asks_for_group_name: true,
    tutorial: "advanced",
    verify: true,
    verify_on_finish: true,
    verification_topics: ["agreements", "actions", "disagreements"],
    explore: true,
    auto_titles: false,
    tag_count: 2,
  });
  expect(byKey.conversation?.summary).toMatchObject({ asks_for_name: false, auto_titles: true });
  expect(byKey.blank?.summary).toMatchObject({ tutorial: "none", verify: false, tag_count: 0 });
});
