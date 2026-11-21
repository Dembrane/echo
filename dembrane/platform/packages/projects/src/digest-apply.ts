import { newId, ValidationError } from "@dembrane/core";
import { v } from "@dembrane/http";
import { z } from "zod";
import { invalidBodyField } from "./body-issues";
import {
  BUILT_IN_TOPICS,
  hostGuideItem,
  NAME_LABEL_MAX,
  type PresetOverrides,
  type ProjectTemplate,
  templateHostGuide,
} from "./project-templates";
import { MAX_KEY_TERMS, MAX_TERM_CHARS, parseKeyTerms } from "./setup/rules";
import type { ProjectsStorage } from "./storage";

/**
 * What a create request carries from the context digest (ECHO-1055), after the host
 * reviewed, edited or switched off each part: written in the creating transaction, beside
 * the template and its overrides. An allow-list, held to the same limits as the template
 * registry: anything else is a 422 naming the field, before anything is written. Privacy
 * and legal settings are not in it; neither are any other project columns.
 */
export const DigestApply = z
  .object({
    context: z.string().max(20_000),
    key_terms: z.array(z.string().min(1).max(MAX_TERM_CHARS)).max(MAX_KEY_TERMS),
    /** Replaces the template's tags: the rounds or agenda parts, in order. */
    tags: z.array(z.string().min(1).max(40)).max(8),
    name_label: z.string().min(1).max(NAME_LABEL_MAX),
    /** The Verify topics participants choose from; the template must have Verify on. */
    verify_topics: z.array(z.enum(BUILT_IN_TOPICS)).min(1).max(3),
    /** A custom Explore prompt: Explore on, in custom mode, with this prompt. */
    explore_prompt: z.string().min(1).max(600),
    /** Steps added after the template's host guide steps; the template must have one. */
    host_script_additions: z.array(z.string().min(1).max(200)).min(1).max(3),
    /** The first goal revision. */
    goal: z.string().min(1).max(1_000),
  })
  .partial()
  .strict();
export type DigestApply = z.infer<typeof DigestApply>;

const invalid = (issues: v.Issue[]) =>
  new ValidationError("validation.invalid_input", {
    details: issues,
    params: { fields: v.fieldProblems(issues) },
  });

/**
 * The digest part of a create request, checked against the allow-list and the template it
 * is applied to. Strings are trimmed; an empty one counts as not sent.
 */
export function parseDigestApply(
  raw: unknown,
  template: ProjectTemplate | null,
  overrides: PresetOverrides | null,
): DigestApply | null {
  if (raw === null || raw === undefined) return null;
  const parsed = DigestApply.safeParse(raw);
  if (!parsed.success) {
    throw invalidBodyField("digest", raw, parsed.error);
  }
  const d = parsed.data;
  const trimmed = (s: string | undefined) => s?.trim() || undefined;
  const list = (l: string[] | undefined) => {
    const out = (l ?? []).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  const out: DigestApply = {
    context: trimmed(d.context),
    key_terms: d.key_terms
      ? parseKeyTerms(d.key_terms.map((t) => t.replaceAll(",", " ")))
      : undefined,
    tags: list(d.tags),
    name_label: trimmed(d.name_label),
    verify_topics: d.verify_topics ? [...new Set(d.verify_topics)] : undefined,
    explore_prompt: trimmed(d.explore_prompt),
    host_script_additions: list(d.host_script_additions),
    goal: trimmed(d.goal),
  };
  // What only makes sense on top of the template's own setup.
  const fields = { ...(template?.preset.fields ?? {}), ...(overrides ?? {}) };
  const issues: v.Issue[] = [];
  const needs = (field: keyof DigestApply, msg: string) =>
    issues.push({ type: "value_error", loc: ["body", "digest", field], msg, input: out[field] });
  if (out.verify_topics && !fields.is_verify_enabled)
    needs("verify_topics", "Verify topics need a template with Verify on");
  if (out.host_script_additions && !template?.preset.host_guide)
    needs("host_script_additions", "Host script steps need a template with a host guide");
  if (issues.length) throw invalid(issues);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as DigestApply;
}

/** The settings a digest's Explore prompt writes: Explore on, custom mode, the prompt. */
export function digestOverrides(d: DigestApply | null): PresetOverrides {
  if (!d?.explore_prompt) return {};
  return {
    is_get_reply_enabled: true,
    get_reply_mode: "custom",
    get_reply_prompt: d.explore_prompt,
  };
}

/**
 * Writes the digest's columns and goal on a project just inserted and templated, inside
 * the creating transaction. With a template, applyProjectTemplate writes the tags (the
 * digest's in place of the template's); without one, this does.
 */
export async function applyDigest(
  store: ProjectsStorage,
  c: {
    projectId: string;
    template: ProjectTemplate | null;
    language: string | null;
    digest: DigestApply;
    createdBy: string | null;
    now: string;
  },
) {
  const d = c.digest;
  const guide = c.template ? templateHostGuide(c.template, c.language) : null;
  const columns = {
    ...(d.context && { context: d.context }),
    ...(d.key_terms?.length && { default_conversation_transcript_prompt: d.key_terms.join(", ") }),
    ...(d.name_label && { conversation_ask_for_participant_name_label: d.name_label }),
    ...(d.verify_topics && { selected_verification_key_list: d.verify_topics.join(",") }),
    ...(guide &&
      d.host_script_additions && {
        host_guide: {
          ...guide,
          steps: [
            ...guide.steps,
            ...d.host_script_additions.map((text) => hostGuideItem(text, c.language)),
          ],
        },
      }),
  };
  if (Object.keys(columns).length)
    await store.updateProject(c.projectId, { ...columns, updated_at: c.now });
  // With a template its preset wrote them already, these in place of its own.
  if (!c.template && d.tags)
    await store.insertTags(
      d.tags.map((text, i) => ({
        id: newId(),
        project_id: c.projectId,
        text,
        sort: i + 1,
        created_at: c.now,
      })),
    );
  if (d.goal)
    await store.insertGoalRevision({
      id: newId(),
      project_id: c.projectId,
      content: d.goal,
      // The host read and kept it on the review screen: theirs, as an edit is.
      set_by: "host-edit",
      chat_id: null,
      created_by: c.createdBy,
      created_at: c.now,
    });
}
