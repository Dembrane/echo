import { type PresetField, PresetFields, type ProjectTemplate } from "../project-templates";
import { oneLine } from "./rules";

/**
 * Settings the suggestions may propose: a subset of the template registry's preset fields
 * (PresetFields), always as a change on top of the chosen template.
 *
 * Left out on purpose:
 * - is_conversation_allowed: closing the portal is never what a new project wants.
 * - image_generation_model and get_reply_mode: one value each, nothing to propose.
 * - default_conversation_ask_for_participant_email and the report notifications it feeds:
 *   collecting emails is a data protection decision (legal basis, privacy notice), the
 *   host's own, and sits behind ENABLE_PARTICIPANT_EMAIL (ECHO-1052).
 * Never, whatever the template allows: anonymize_transcripts (removes audio for good), the
 * legal basis, the privacy policy URL, visibility and anything paid (the event call to
 * action). None of the proposable fields is gated to a tier today; the test pins that.
 */
export const PROPOSABLE_FIELDS = [
  "default_conversation_ask_for_participant_name",
  "default_conversation_tutorial_slug",
  "is_verify_enabled",
  "is_verify_on_finish_enabled",
  "is_get_reply_enabled",
  "enable_ai_title_and_tags",
] as const satisfies readonly PresetField[];
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];

export const NEVER_PROPOSED = [
  "anonymize_transcripts",
  "legal_basis",
  "privacy_policy_url",
  "visibility",
  "is_dembrane_event_cta_enabled",
  "default_conversation_ask_for_participant_email",
  "is_project_notification_subscription_allowed",
  "is_conversation_allowed",
] as const;

/** Most proposals shown at once: a short list the host can read in one look. */
export const MAX_SETTING_PROPOSALS = 4;

/** What a new project holds for a field the preset leaves alone (the database defaults). */
const COLUMN_DEFAULTS: Record<ProposableField, boolean | string> = {
  default_conversation_ask_for_participant_name: true,
  default_conversation_tutorial_slug: "None",
  is_verify_enabled: false,
  is_verify_on_finish_enabled: false,
  is_get_reply_enabled: false,
  enable_ai_title_and_tags: false,
};

export interface ProposedSetting {
  readonly field: ProposableField;
  readonly current: boolean | string;
  readonly proposed: boolean | string;
  readonly reason: string;
}

/** The value a field has once the template is applied. */
export function templateValue(t: ProjectTemplate, field: ProposableField): boolean | string {
  const v = (t.preset.fields as Record<string, unknown>)[field];
  return (v as boolean | string | undefined) ?? COLUMN_DEFAULTS[field];
}

/** A value as the model wrote it ("true", "advanced"), as the field's own type. */
function parseValue(field: ProposableField, raw: string): boolean | string | null {
  const text = raw.trim();
  const candidate =
    field === "default_conversation_tutorial_slug"
      ? text.toLowerCase() === "none"
        ? "None"
        : text.toLowerCase()
      : text.toLowerCase() === "true"
        ? true
        : text.toLowerCase() === "false"
          ? false
          : null;
  if (candidate === null) return null;
  const parsed = PresetFields.shape[field].safeParse(candidate);
  return parsed.success ? (parsed.data as boolean | string) : null;
}

/**
 * The model's proposals, cleaned: known proposable fields only, a valid value, a reason,
 * an actual change from the template, each field once, Verify-on-finish only with Verify,
 * and at most MAX_SETTING_PROPOSALS. Zero is a valid answer.
 */
export function cleanSettings(
  raw: readonly { field: string; value: string; reason: string }[],
  template: ProjectTemplate,
): ProposedSetting[] {
  const out: ProposedSetting[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!(PROPOSABLE_FIELDS as readonly string[]).includes(r.field)) continue;
    const field = r.field as ProposableField;
    if (seen.has(field)) continue;
    const proposed = parseValue(field, r.value);
    const reason = oneLine(r.reason);
    if (proposed === null || !reason) continue;
    const current = templateValue(template, field);
    if (proposed === current) continue;
    seen.add(field);
    out.push({ field, current, proposed, reason });
  }
  // Reminding on finish means nothing without Verify itself.
  const verifyOn = (list: ProposedSetting[]) =>
    list.find((s) => s.field === "is_verify_enabled")?.proposed ??
    templateValue(template, "is_verify_enabled");
  const kept = out.filter(
    (s) => s.field !== "is_verify_on_finish_enabled" || s.proposed === false || verifyOn(out),
  );
  return kept.slice(0, MAX_SETTING_PROPOSALS);
}
