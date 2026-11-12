export type FeatureGroup =
  | "chat"
  | "assistant"
  | "reports"
  | "map"
  | "analysis"
  | "canvas"
  | "portal"
  | "recording"
  | "voice"
  | "other";

export interface FeatureRule {
  /** Regex source, stored as text in Postgres. */
  readonly pattern: string;
  readonly group: FeatureGroup;
  readonly label: string;
}

export const FEATURE_GROUP_LABELS: Readonly<Record<FeatureGroup, string>> = {
  analysis: "Analysis",
  assistant: "Assistant",
  canvas: "Canvas",
  chat: "Chat",
  map: "Map",
  other: "Other",
  portal: "Portal",
  recording: "Recording",
  reports: "Reports",
  voice: "Voice input",
};

export const UNLABELLED = "Unlabelled";

// Route operations are "METHOD /route"; jobs and workflows use their name. First match wins.
export const FEATURE_RULES: readonly FeatureRule[] = [
  { pattern: String.raw`^POST \/api\/chats\/:chat_id$`, group: "chat", label: "Replies" },
  {
    pattern: String.raw`^\w+ \/api\/chats\/:chat_id\/suggestions$`,
    group: "chat",
    label: "Suggestions",
  },
  {
    pattern: String.raw`^\w+ \/api\/(chats|v2\/bff\/(chats|chat-messages))(\/|$)`,
    group: "chat",
    label: "Chat",
  },
  { pattern: String.raw`^agentic\.turn(\.|$)`, group: "assistant", label: "Assistant turns" },
  { pattern: String.raw`^POST \/api\/agentic\/runs$`, group: "assistant", label: "New runs" },
  {
    pattern: String.raw`^POST \/api\/agentic\/runs\/:run_id\/messages$`,
    group: "assistant",
    label: "Follow-up messages",
  },
  {
    pattern: String.raw`^(agentic\.|\w+ \/api\/agentic\/)`,
    group: "assistant",
    label: "Assistant",
  },
  { pattern: String.raw`^reports\.generate$`, group: "reports", label: "Report generation" },
  {
    pattern: String.raw`^(reports\.|\w+ \/api\/(projects\/:project_id\/(reports|create-report)|v2\/bff\/reports))`,
    group: "reports",
    label: "Reports",
  },
  { pattern: String.raw`^map\.group$`, group: "map", label: "Groups" },
  { pattern: String.raw`^map\.fact_check$`, group: "map", label: "Fact checks" },
  { pattern: String.raw`^(map\.|\w+ \/api\/v2\/bff\/map(\/|$))`, group: "map", label: "Map" },
  {
    pattern: String.raw`^popcorn\.tick\.translation$`,
    group: "analysis",
    label: "Popcorn translation",
  },
  { pattern: String.raw`^popcorn\.tick\.`, group: "analysis", label: "Popcorn ticks" },
  {
    pattern: String.raw`^(popcorn\.|\w+ \/api\/v2\/(bff\/)?popcorn(\/|$))`,
    group: "analysis",
    label: "Popcorn",
  },
  { pattern: String.raw`^analysis\.run$`, group: "analysis", label: "Analysis runs" },
  {
    pattern: String.raw`^(analysis\.|\w+ \/api\/v2\/bff\/analysis(\/|$))`,
    group: "analysis",
    label: "Analysis",
  },
  { pattern: String.raw`^canvas\.tick$`, group: "canvas", label: "Canvas ticks" },
  {
    pattern: String.raw`^(canvas\.|\w+ \/api\/v2\/bff\/canvases(\/|$))`,
    group: "canvas",
    label: "Canvas",
  },
  { pattern: String.raw`^(verify(\.|$)|\w+ \/api\/verify\/)`, group: "portal", label: "Verify" },
  {
    pattern: String.raw`^POST \/api\/conversations\/:conversation_id\/get-reply$`,
    group: "portal",
    label: "Explore",
  },
  { pattern: String.raw`^conversations\.chunk$`, group: "recording", label: "Transcription" },
  { pattern: String.raw`^conversations\.finish$`, group: "recording", label: "Finishing" },
  {
    pattern: String.raw`^conversations\.finalize$`,
    group: "recording",
    label: "Finalize and summary",
  },
  {
    pattern: String.raw`^conversations\.final-transcript$`,
    group: "recording",
    label: "Final transcript",
  },
  {
    pattern: String.raw`^(conversations\.summarize|POST \/api\/conversations\/:conversation_id\/summarize)$`,
    group: "recording",
    label: "Conversation summaries",
  },
  {
    pattern: String.raw`^POST \/api\/conversations\/:conversation_id\/generate-title$`,
    group: "recording",
    label: "Titles and tags",
  },
  {
    pattern: String.raw`^POST \/api\/conversations\/:conversation_id\/retranscribe$`,
    group: "recording",
    label: "Retranscribe",
  },
  {
    pattern: String.raw`^(conversations\.|\w+ \/api\/(conversations|participant)\/)`,
    group: "recording",
    label: "Recording",
  },
  {
    pattern: String.raw`^POST \/api\/stateless\/transcribe$`,
    group: "voice",
    label: "Voice input",
  },
];

const COMPILED = FEATURE_RULES.map((r) => ({ re: new RegExp(r.pattern), rule: r }));

/** The feature group and plain name of a recorded operation; unknown ones keep their raw key. */
export function classifyOperation(operation: string | null): {
  group: FeatureGroup;
  group_label: string;
  label: string;
} {
  const op = operation ?? "";
  for (const { re, rule } of COMPILED)
    if (re.test(op))
      return {
        group: rule.group,
        group_label: FEATURE_GROUP_LABELS[rule.group],
        label: rule.label,
      };
  return { group: "other", group_label: FEATURE_GROUP_LABELS.other, label: op || UNLABELLED };
}
