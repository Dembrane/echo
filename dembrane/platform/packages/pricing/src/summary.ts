/**
 * The answers in one short English line for the team (build_answers_summary). Only keys
 * travel on the wire; an option missing here falls through as itself.
 */
const LABELS: readonly [string, string][] = [
  ["use_case", "Use case"],
  ["timing", "Timing"],
  ["volume", "Volume"],
  ["concurrency", "At once"],
  ["extras", "Extras"],
  ["context", "Notes"],
];

const OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  use_case: {
    event_workshop: "an event or a workshop",
    assembly: "an assembly",
    conference_sessions: "recording conference sessions",
    in_person: "in person conversations",
    audio_survey: "an audio survey",
    something_else: "something else",
  },
  volume: {
    under_50: "under 50",
    "50_to_250": "50 to 250",
    "250_to_1000": "250 to 1000",
    over_1000: "more than 1000",
    not_sure: "not sure",
  },
  concurrency: {
    just_one: "just one",
    "2_to_5": "2 to 5",
    "6_to_15": "6 to 15",
    "16_to_40": "16 to 40",
    more_than_40: "more than 40",
    not_sure: "not sure",
  },
  extras: { event_help: "event help", procurement_help: "procurement help" },
};

const TEXT_LIMIT = 160;
const SUMMARY_LIMIT = 600;

/** Python str.split() whitespace: collapse runs, trim ends. */
const PY_SPACE = new Set([0x1c, 0x1d, 0x1e, 0x1f, 0x85].map((c) => String.fromCharCode(c)));
function flatten(s: string): string {
  const spaced = [...s].map((ch) => (PY_SPACE.has(ch) ? " " : ch)).join("");
  return spaced.split(/\s+/u).filter(Boolean).join(" ");
}

function pyRstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

export function summaryText(value: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof value !== "string") return null;
  const flat = flatten(value);
  if (!flat) return null;
  const chars = [...flat];
  return chars.length <= limit ? flat : `${pyRstrip(chars.slice(0, limit - 3).join(""))}...`;
}

function choices(
  question: string,
  chosen: unknown,
  answers: Record<string, unknown>,
): string | null {
  const labels = OPTIONS[question] ?? {};
  const keys = Array.isArray(chosen) ? chosen : [chosen];
  const parts: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string" || !key) continue;
    let label = Object.hasOwn(labels, key) ? (labels[key] as string) : key;
    if (key === "something_else") {
      const typed = summaryText(answers.use_case_other);
      if (typed) label = `${label}: ${typed}`;
    }
    if (key === "more_than_40") {
      const exact = summaryText(answers.concurrency_exact, 12);
      if (exact && /^\d+$/.test(exact)) label = `${label} (${exact})`;
    }
    parts.push(label);
  }
  return parts.length ? parts.join(", ") : null;
}

export function buildAnswersSummary(answersRaw: unknown): string {
  if (!answersRaw || typeof answersRaw !== "object" || Array.isArray(answersRaw)) return "";
  const answers = answersRaw as Record<string, unknown>;
  const parts: string[] = [];
  for (const [q, label] of LABELS) {
    const value = q in OPTIONS ? choices(q, answers[q], answers) : summaryText(answers[q]);
    if (value) parts.push(`${label}: ${value}`);
  }
  const line = parts.join(" | ");
  const chars = [...line];
  return chars.length <= SUMMARY_LIMIT
    ? line
    : `${pyRstrip(chars.slice(0, SUMMARY_LIMIT - 3).join(""))}...`;
}
