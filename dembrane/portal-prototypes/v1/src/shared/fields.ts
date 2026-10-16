/**
 * The project settings a host can change: every key the API's
 * PATCH /api/v2/bff/projects/:id accepts (PROJECT_UPDATE_FIELDS in
 * dembrane/platform/packages/projects/src/projects.ts), with the type its
 * validator expects (updateShape in packages/projects/src/routes.ts).
 * The Worker only passes these on; the page builds its form from them.
 */
export type FieldKind = "text" | "longtext" | "bool" | "select" | "json";

export interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly group: GroupKey;
  readonly description?: string;
  /** For `select`: value → label. */
  readonly options?: Readonly<Record<string, string>>;
}

export const GROUPS = {
  general: "General",
  portal: "Participant portal",
  transcripts: "Transcripts and AI",
  reply: "Get reply",
  verify: "Verify",
  canvas: "Canvas",
  legal: "Legal",
  advanced: "Advanced",
} as const;
export type GroupKey = keyof typeof GROUPS;

// The same lists as the dashboard's portal editor (dembrane/frontend/src/components/project/ProjectPortalEditor.tsx).
const LANGUAGES = {
  en: "English",
  nl: "Dutch",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  uk: "Ukrainian",
  cs: "Czech",
};
const TUTORIALS = { none: "None", basic: "Basic", advanced: "Advanced" };

export const FIELDS: readonly FieldDef[] = [
  { key: "name", label: "Name", kind: "text", group: "general" },
  {
    key: "language",
    label: "Language",
    kind: "select",
    group: "general",
    options: LANGUAGES,
    description: "The participant portal's language.",
  },
  {
    key: "context",
    label: "Context",
    kind: "longtext",
    group: "general",
    description: "What the project is about, for the AI features.",
  },

  {
    key: "is_conversation_allowed",
    label: "Allow new conversations",
    kind: "bool",
    group: "portal",
  },
  {
    key: "default_conversation_title",
    label: "Portal title",
    kind: "text",
    group: "portal",
  },
  {
    key: "default_conversation_description",
    label: "Portal description",
    kind: "longtext",
    group: "portal",
  },
  {
    key: "default_conversation_finish_text",
    label: "Finish text",
    kind: "longtext",
    group: "portal",
    description: "Shown when a participant finishes.",
  },
  {
    key: "default_conversation_ask_for_participant_name",
    label: "Ask for the participant's name",
    kind: "bool",
    group: "portal",
  },
  {
    key: "default_conversation_ask_for_participant_email",
    label: "Ask for the participant's email",
    kind: "bool",
    group: "portal",
  },
  {
    key: "default_conversation_tutorial_slug",
    label: "Tutorial",
    kind: "select",
    group: "portal",
    options: TUTORIALS,
  },
  {
    key: "tutorial_slug",
    label: "Project tutorial slug",
    kind: "text",
    group: "portal",
  },
  {
    key: "is_project_notification_subscription_allowed",
    label: "Let participants subscribe to updates",
    kind: "bool",
    group: "portal",
  },
  {
    key: "is_dembrane_event_cta_enabled",
    label: "Show the dembrane event invitation",
    kind: "bool",
    group: "portal",
    description: "Turning it off needs a paid workspace.",
  },

  {
    key: "default_conversation_transcript_prompt",
    label: "Transcription hints",
    kind: "longtext",
    group: "transcripts",
    description: "Names and terms that help the transcription.",
  },
  {
    key: "anonymize_transcripts",
    label: "Anonymise transcripts",
    kind: "bool",
    group: "transcripts",
  },
  {
    key: "enable_ai_title_and_tags",
    label: "AI titles and tags",
    kind: "bool",
    group: "transcripts",
  },
  {
    key: "conversation_title_prompt",
    label: "Title prompt",
    kind: "longtext",
    group: "transcripts",
  },
  {
    key: "image_generation_model",
    label: "Image style",
    kind: "select",
    group: "transcripts",
    options: { MODEST: "Modest", EXTRAVAGANT: "Extravagant", PLACEHOLDER: "Placeholder" },
  },

  { key: "is_get_reply_enabled", label: "Enable Get reply", kind: "bool", group: "reply" },
  {
    key: "get_reply_mode",
    label: "Reply mode",
    kind: "select",
    group: "reply",
    options: { summarize: "Summarize", brainstorm: "Brainstorm", custom: "Custom" },
  },
  {
    key: "get_reply_prompt",
    label: "Custom reply prompt",
    kind: "longtext",
    group: "reply",
    description: "Used when the mode is Custom.",
  },

  { key: "is_verify_enabled", label: "Enable Verify", kind: "bool", group: "verify" },
  {
    key: "is_verify_on_finish_enabled",
    label: "Verify when a participant finishes",
    kind: "bool",
    group: "verify",
  },
  {
    key: "selected_verification_key_list",
    label: "Verification topics",
    kind: "text",
    group: "verify",
    description: "Topic keys, separated by commas.",
  },

  { key: "is_canvas_enabled", label: "Enable Canvas", kind: "bool", group: "canvas" },

  {
    key: "legal_basis",
    label: "Legal basis",
    kind: "select",
    group: "legal",
    options: {
      "client-managed": "Client-managed",
      consent: "Consent",
      "dembrane-events": "dembrane events",
    },
    description: "Changing it needs the settings:manage permission.",
  },
  { key: "privacy_policy_url", label: "Privacy policy URL", kind: "text", group: "legal" },

  {
    key: "host_guide",
    label: "Host guide",
    kind: "json",
    group: "advanced",
    description: "A JSON object.",
  },
  {
    key: "methodology_version_id",
    label: "Methodology version ID",
    kind: "text",
    group: "advanced",
  },
];

export const FIELD_KEYS: ReadonlySet<string> = new Set(FIELDS.map((f) => f.key));

/** A project's settings, as JSON values; null means unset. */
export type Config = Record<string, unknown>;

/** What GET and PATCH /api/projects/:id/config answer. */
export interface ConfigView {
  readonly config: Config;
  /** Fields saved here but not yet accepted by the API. */
  readonly pending: readonly string[];
  readonly lastSyncedAt: number | null;
  /** The signed-in person's role on the project, from the API. */
  readonly role: string | null;
  /** Fields the API refused on the last save, with its error. */
  readonly rejected?: { readonly fields: readonly string[]; readonly error: ApiError };
}

/** An error from the dembrane API, passed through as it was sent. */
export interface ApiError {
  readonly status: number;
  readonly body: unknown;
}
