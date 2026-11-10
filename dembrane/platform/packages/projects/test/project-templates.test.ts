import { expect, test } from "bun:test";
import { ValidationError } from "@dembrane/core";
import {
  BUILT_IN_TOPICS,
  listProjectTemplates,
  overridesOver,
  PROJECT_TEMPLATE_KEYS,
  PROJECT_TEMPLATES,
  parseOverrides,
  projectTemplate,
  TEMPLATE_LANGUAGES,
  templateColumns,
  templateHostGuide,
  templateTags,
} from "../src/project-templates";
import { PROJECT_UPDATE_FIELDS } from "../src/projects";

const OLD_KEYS = ["blank", "conversation", "event", "series", "upload"];
const cards = PROJECT_TEMPLATES.filter((t) => t.card.offer === "card");

test("the registry holds the purpose templates and the old keys, each once", () => {
  expect(new Set(PROJECT_TEMPLATE_KEYS).size).toBe(PROJECT_TEMPLATE_KEYS.length);
  for (const k of OLD_KEYS) expect(PROJECT_TEMPLATE_KEYS as string[]).toContain(k);
  expect(cards.length).toBeGreaterThanOrEqual(12);
  expect(cards.length).toBeLessThanOrEqual(16);
});

test("the old logistic keys are still valid but offered nowhere; upload and blank are links", () => {
  for (const k of ["conversation", "series", "event"])
    expect([k, projectTemplate(k).card.offer]).toEqual([k, "none"]);
  for (const k of ["upload", "blank"])
    expect([k, projectTemplate(k).card.offer]).toEqual([k, "link"]);
  // Their settings did not change; the version moved with the registry.
  for (const k of OLD_KEYS) expect(projectTemplate(k).version).toBe(2);
});

test("every card has a verb, a setup and a host guide in every language", () => {
  for (const t of cards) {
    expect([t.key, t.card.verbs.length >= 1 && t.card.verbs.length <= 2]).toEqual([t.key, true]);
    expect([t.key, ["one_recording", "many_groups"].includes(t.card.setup)]).toEqual([t.key, true]);
    for (const lang of ["en", "nl"]) {
      const g = templateHostGuide(t, lang);
      expect([t.key, lang, !!g?.title]).toEqual([t.key, lang, true]);
      expect(g?.steps.length).toBeGreaterThanOrEqual(3);
      expect(g?.steps.length).toBeLessThanOrEqual(6);
      expect(g?.tips.length).toBeGreaterThanOrEqual(1);
    }
  }
});

test("the cards cover the five verbs and both setups, with a short featured set of each", () => {
  const verbs = new Set(cards.flatMap((t) => t.card.verbs));
  expect([...verbs].sort()).toEqual(["align", "decide", "explore", "gather", "understand"]);
  const featured = cards.filter((t) => t.card.featured);
  expect(featured.length).toBeGreaterThanOrEqual(5);
  expect(featured.length).toBeLessThanOrEqual(6);
  expect(new Set(featured.map((t) => t.card.setup)).size).toBe(2);
});

test("a preset only sets fields the project PATCH accepts", () => {
  const allowed = new Set<string>(PROJECT_UPDATE_FIELDS);
  for (const t of PROJECT_TEMPLATES)
    for (const k of Object.keys(templateColumns(t, "en")))
      if (k !== "template_key" && k !== "template_version")
        expect([t.key, k, allowed.has(k) || k === "is_conversation_allowed"]).toEqual([
          t.key,
          k,
          true,
        ]);
});

test("no preset touches what removes audio, decides the legal basis, asks for email or is paid", () => {
  const never = [
    "anonymize_transcripts",
    "legal_basis",
    "privacy_policy_url",
    "is_dembrane_event_cta_enabled",
    "default_conversation_ask_for_participant_email",
    "is_project_notification_subscription_allowed",
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
    template_version: 2,
  });
  expect(templateTags(projectTemplate("blank"), "en")).toEqual([]);
});

test("event still asks for a table or group, seeds the rounds and turns on Verify and Explore", () => {
  const cols = templateColumns(projectTemplate("event"), "de");
  expect(cols).toMatchObject({
    conversation_ask_for_participant_name_label: "Name des Tisches oder der Gruppe",
    default_conversation_tutorial_slug: "advanced",
    selected_verification_key_list: "agreements,actions,disagreements",
    get_reply_mode: "summarize",
  });
  expect(cols.host_guide).toBeUndefined();
  expect(templateTags(projectTemplate("event"), "en-US")).toEqual(["Round 1", "Round 2"]);
});

test("a resident evening: one topic, the table check; Explore; rounds; the table name", () => {
  const cols = templateColumns(projectTemplate("resident_evening"), "nl");
  expect(cols).toMatchObject({
    default_conversation_ask_for_participant_name: true,
    conversation_ask_for_participant_name_label: "Naam of nummer van je tafel",
    is_verify_enabled: true,
    is_verify_on_finish_enabled: true,
    selected_verification_key_list: "agreements",
    is_get_reply_enabled: true,
    get_reply_mode: "summarize",
  });
  expect(cols.is_get_reply_cross_pollination_enabled).toBeUndefined();
  expect(templateTags(projectTemplate("resident_evening"), "nl")).toEqual(["Ronde 1", "Ronde 2"]);
});

test("cross-pollination only where hearing other groups is the point, never for sensitive ones", () => {
  const on = PROJECT_TEMPLATES.filter((t) => t.preset.fields.is_get_reply_cross_pollination_enabled)
    .map((t) => t.key)
    .sort();
  expect(on).toEqual(["conference", "ideation", "world_cafe"]);
  for (const k of ["interviews", "kitchen_table", "citizens_assembly"])
    expect([k, projectTemplate(k).preset.fields.is_get_reply_enabled ?? false]).toEqual([k, false]);
});

test("the host guide is stored the way the host guide page reads it, in the project's language", () => {
  const g = templateHostGuide(projectTemplate("resident_evening"), "nl");
  expect(g?.language).toBe("nl");
  expect(g?.title).toBe("Een tafel leiden op de bewonersavond");
  for (const item of [...(g?.steps ?? []), ...(g?.tips ?? [])]) {
    expect(typeof item.content).toBe("string");
    expect(Array.isArray(item.highlights)).toBe(true);
    for (const h of item.highlights) expect(item.content).toContain(h);
  }
  // The portal's own button names are coloured.
  expect(g?.steps.flatMap((s) => s.highlights)).toContain("Goedkeuren");
  // A language without its own words falls back to English, under the project's code.
  const multi = templateHostGuide(projectTemplate("resident_evening"), "multi");
  expect(multi?.language).toBe("mu");
  expect(multi?.title).toBe("Hosting a table at a resident evening");
});

test("every template's texts exist in every language and say no dembrane with a capital", () => {
  for (const t of PROJECT_TEMPLATES)
    for (const lang of TEMPLATE_LANGUAGES) {
      const g = templateHostGuide(t, lang);
      const words = [
        ...(g ? [g.title, ...g.steps.map((s) => s.content), ...g.tips.map((s) => s.content)] : []),
        ...templateTags(t, lang),
      ];
      for (const w of words) {
        expect(w.length).toBeGreaterThan(0);
        expect(w).not.toContain("Dembrane");
        expect(w).not.toContain("—");
      }
    }
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

test("the list says what each template sets up and how it is offered, in the language asked", () => {
  const byKey = Object.fromEntries(listProjectTemplates("nl").templates.map((t) => [t.key, t]));
  expect(byKey.upload?.landing).toBe("upload");
  expect(byKey.upload?.card.offer).toBe("link");
  expect(byKey.resident_evening?.card).toEqual({
    offer: "card",
    verbs: ["understand", "decide"],
    setup: "many_groups",
    sectors: ["public"],
    featured: true,
    method: null,
  });
  expect(byKey.resident_evening?.summary).toEqual({
    asks_for_name: true,
    asks_for_group_name: true,
    name_label: "Naam of nummer van je tafel",
    tutorial: "advanced",
    verify: true,
    verify_on_finish: true,
    verification_topics: ["agreements"],
    explore: true,
    explore_mode: "summarize",
    cross_pollination: false,
    auto_titles: false,
    tag_count: 2,
    tags: ["Ronde 1", "Ronde 2"],
    host_guide_title: "Een tafel leiden op de bewonersavond",
  });
  expect(byKey.world_cafe?.card.method).toBe("World Café");
  expect(byKey.ideation?.summary.explore_mode).toBe("brainstorm");
  expect(byKey.interviews?.summary.explore_mode).toBeNull();
  expect(byKey.blank?.summary).toMatchObject({ tutorial: "none", verify: false, tag_count: 0 });
  expect(
    listProjectTemplates(null).templates.find((t) => t.key === "strategy_day")?.summary.tags,
  ).toEqual(["Morning", "Afternoon"]);
});

// ECHO-1052: asking for the participant's email sits behind ENABLE_PARTICIPANT_EMAIL, so no
// template may switch it on, and neither may the create request's overrides.
test("overrides follow the preset fields and refuse email", () => {
  expect(() => parseOverrides({ default_conversation_ask_for_participant_email: true })).toThrow(
    ValidationError,
  );
  expect(parseOverrides({ is_get_reply_cross_pollination_enabled: true })).toEqual({
    is_get_reply_cross_pollination_enabled: true,
  });
  // The schema grew: brainstorm and a custom prompt are preset fields now.
  expect(parseOverrides({ get_reply_mode: "brainstorm" })).toEqual({
    get_reply_mode: "brainstorm",
  });
  expect(parseOverrides({ get_reply_mode: "custom", get_reply_prompt: "Ask one thing." })).toEqual({
    get_reply_mode: "custom",
    get_reply_prompt: "Ask one thing.",
  });
  // Localised template words are not overrides.
  for (const raw of [
    { conversation_ask_for_participant_name_label: "Tafel" },
    { selected_verification_key_list: "gems" },
    { host_guide: {} },
    { get_reply_mode: "socratic" },
  ])
    expect(() => parseOverrides(raw)).toThrow(ValidationError);
  expect(BUILT_IN_TOPICS).toContain("heard");
});

test("an override equal to the template's own value is dropped", () => {
  const t = projectTemplate("resident_evening");
  expect(
    overridesOver(t, {
      is_verify_enabled: true,
      is_get_reply_enabled: false,
      enable_ai_title_and_tags: false,
    }),
  ).toEqual({ is_get_reply_enabled: false, enable_ai_title_and_tags: false });
});
