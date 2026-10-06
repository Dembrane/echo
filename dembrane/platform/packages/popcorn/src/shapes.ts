import { type Issue, p, type Type } from "@dembrane/legacy-shape";

/**
 * The request shapes the popcorn and present routes validate, as pydantic 2.12 declared
 * them in the Python API: the same field order, coercions and 422 entries, because the
 * dashboard shows these messages. The few pydantic types @dembrane/legacy-shape does not carry
 * (unions of literals, dict[str, bool], datetime) are built here.
 */

const { model, nested, optional, required, nullable, str, int, bool, literal, list } = p;

const URL = "https://errors.pydantic.dev/2.12/v/";

function issue(
  type: string,
  loc: readonly (string | number)[],
  msg: string,
  input: unknown,
  ctx?: Record<string, unknown>,
): Issue {
  return { type, loc, msg, input, ...(ctx && { ctx }), url: `${URL}${type}` };
}

/** The parse result the shared types use for a failure, found by probing one. */
const failure: unknown = (() => {
  const issues: Issue[] = [];
  return str().parse(0, [], issues);
})();

/**
 * `Literal[...] | Literal[...]`: pydantic tries each member and, when all fail, reports one
 * error per member with the member's tag appended to the location.
 */
export function literalUnion(...members: readonly (readonly string[])[]): Type<string> {
  return {
    parse(v, loc, issues) {
      for (const m of members) if (typeof v === "string" && m.includes(v)) return v;
      for (const m of members) {
        const tag = `literal[${m.map((x) => `'${x}'`).join(",")}]`;
        const quoted = m.map((x) => `'${x}'`);
        const expected =
          quoted.length > 1
            ? `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`
            : (quoted[0] ?? "");
        issues.push(
          issue("literal_error", [...loc, tag], `Input should be ${expected}`, v, { expected }),
        );
      }
      return failure as string;
    },
  };
}

/** dict[str, bool] */
export function boolDict(): Type<Record<string, boolean>> {
  const b = bool();
  return {
    parse(v, loc, issues) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        issues.push(issue("dict_type", loc, "Input should be a valid dictionary", v));
        return failure as Record<string, boolean>;
      }
      const out: Record<string, boolean> = {};
      let failed = false;
      for (const [k, x] of Object.entries(v)) {
        const r = b.parse(x, [...loc, k], issues);
        if (r === failure) failed = true;
        else out[k] = r as boolean;
      }
      return failed ? (failure as Record<string, boolean>) : out;
    },
  };
}

const DIGITS = /^\d+$/;

/** The reason speedate gives for the date part of a string, or null when it parses. */
function dateProblem(s: string): string | null {
  if (s.length < 10) return "input is too short";
  if (!DIGITS.test(s.slice(0, 4))) return "invalid character in year";
  if (s[4] !== "-") return "invalid date separator, expected `-`";
  if (!DIGITS.test(s.slice(5, 7))) return "invalid character in month";
  if (s[7] !== "-") return "invalid date separator, expected `-`";
  if (!DIGITS.test(s.slice(8, 10))) return "invalid character in day";
  const month = Number(s.slice(5, 7));
  if (month < 1 || month > 12) return "month value is outside expected range of 1-12";
  const day = Number(s.slice(8, 10));
  const year = Number(s.slice(0, 4));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > days) return "day value is outside expected range";
  return null;
}

const TIME = /^[T t]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|z|[+-]\d{2}(:?\d{2})?)?$/;

/**
 * pydantic's lax datetime: a datetime or a date string, a unix timestamp as a number or a
 * string of digits. Bad strings report speedate's reason; other types datetime_type.
 */
export function datetime(): Type<string | number> {
  return {
    parse(v, loc, issues) {
      if (typeof v === "number") return v;
      if (typeof v !== "string") {
        issues.push(issue("datetime_type", loc, "Input should be a valid datetime", v));
        return failure as string;
      }
      if (/^[+-]?\d+(\.\d+)?$/.test(v)) return v;
      const problem = dateProblem(v);
      let reason = problem;
      if (!problem && v.length > 10) {
        const rest = v.slice(10);
        const m = TIME.exec(rest);
        const [hh, mm] = m ? rest.slice(1, 6).split(":").map(Number) : [99, 99];
        if (!m || (hh ?? 99) > 23 || (mm ?? 99) > 59)
          reason = "unexpected extra characters at the end of the input";
      }
      if (reason) {
        issues.push(
          issue(
            "datetime_from_date_parsing",
            loc,
            `Input should be a valid datetime or date, ${reason}`,
            v,
            {
              error: reason,
            },
          ),
        );
        return failure as string;
      }
      return v;
    },
  };
}

export const LANGUAGE_CODES = ["en", "nl", "de", "fr", "es", "it", "uk", "cs"] as const;
const BLOCKS = ["popcorn", "stakeholders", "tensions", "map"] as const;

export const voiceBody = model({
  presets: optional(nullable(list(str())), null),
  note: optional(nullable(str({ max: 600 })), null),
});

export const introBody = model({
  enabled: optional(nullable(bool()), null),
  title: optional(nullable(str({ max: 160 })), null),
  subtitle: optional(nullable(str({ max: 600 })), null),
});

export const disclosureBody = model({
  enabled: optional(nullable(bool()), null),
  text: optional(nullable(str({ max: 600 })), null),
  invitation_title: optional(nullable(str({ max: 160 })), null),
  invitation_text: optional(nullable(str({ max: 600 })), null),
});

export const noticeBody = model({
  enabled: optional(nullable(bool()), null),
  text: optional(nullable(str({ max: 160 })), null),
});

export const dataBody = model({ enabled: optional(nullable(bool()), null) });

export const guideBody = model({
  enabled: optional(nullable(bool()), null),
  title: optional(nullable(str({ max: 160 })), null),
  steps: optional(nullable(str({ max: 1200 })), null),
});

export const languageBody = model({
  ui: optional(nullable(literalUnion(["auto"], LANGUAGE_CODES)), null),
  // "" asks for the original language again.
  translate_to: optional(nullable(literalUnion([""], LANGUAGE_CODES)), null),
  // The whole list is sent every time; [] asks for none.
  also: optional(nullable(list(literal(...LANGUAGE_CODES), { max: 3 })), null),
});

export const presentationBody = model({
  blocks: optional(nullable(list(literal(...BLOCKS), { max: 4 })), null),
  opening: optional(nullable(literal(...BLOCKS)), null),
  language_policy: optional(nullable(literal("project", "explicit")), null),
  hidden_items: optional(nullable(list(str(), { max: 2000 })), null),
});

export const settingsBody = model({
  presentation: optional(nullable(nested(presentationBody)), null),
  title: optional(nullable(str({ min: 1, max: 160 })), null),
  client: optional(nullable(str({ max: 160 })), null),
  tabs: optional(nullable(boolDict()), null),
  public: optional(nullable(bool()), null),
  show_qr: optional(nullable(bool()), null),
  show_branding: optional(nullable(bool()), null),
  public_labels: optional(nullable(literal("names", "neutral")), null),
  voice: optional(nullable(nested(voiceBody)), null),
  intro: optional(nullable(nested(introBody)), null),
  disclosure: optional(nullable(nested(disclosureBody)), null),
  notice: optional(nullable(nested(noticeBody)), null),
  data: optional(nullable(nested(dataBody)), null),
  guide: optional(nullable(nested(guideBody)), null),
  language: optional(nullable(nested(languageBody)), null),
});

export const createBody = model({
  project_id: required(str()),
  title: required(str({ min: 1, max: 160 })),
  client: optional(nullable(str({ max: 160 })), null),
  voice: optional(nullable(nested(voiceBody)), null),
  // Older clients still send these; a session starts in manual mode, live has its own call.
  cadence_minutes: optional(nullable(int()), null),
  expires_at: optional(nullable(datetime()), null),
});

export const liveBody = model({
  hours: required(int()),
  // "Ready by": the first read is booked a fixed lead before this time, not now.
  ready_by: optional(nullable(datetime()), null),
});

export const loopSettingsBody = model({
  cadence_minutes: optional(nullable(int()), null),
  expires_at: required(datetime()),
});

/** model_dump(exclude_none=True): nested models too, None values dropped at every level. */
export function excludeNone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(excludeNone);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      if (x !== null && x !== undefined) out[k] = excludeNone(x);
    return out;
  }
  return v;
}
