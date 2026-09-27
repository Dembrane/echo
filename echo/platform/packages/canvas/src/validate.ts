import { p } from "@echo/legacy-shape";

type Loc = readonly (string | number)[];
type IssueList = Parameters<p.Type<unknown>["parse"]>[2];

// legacy-shape keeps its failure marker private; any failing parse hands it back.
const FAIL = p.int().parse("not a number", [], []) as never;

const URL = "https://errors.pydantic.dev/2.12/v/";

function fail(issues: IssueList, loc: Loc, input: unknown, error: string): never {
  issues.push({
    type: "datetime_from_date_parsing",
    loc,
    msg: `Input should be a valid datetime or date, ${error}`,
    input,
    ctx: { error },
    url: `${URL}datetime_from_date_parsing`,
  });
  return FAIL;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

function fromUnix(n: number): Date {
  // pydantic reads large numbers as milliseconds.
  return new Date(Math.abs(n) > 2e10 ? n : n * 1000);
}

/**
 * pydantic's datetime field in lax mode for the inputs clients send: ISO dates and
 * datetimes (a naive one stays naive and the route reads it as UTC), and unix
 * timestamps as numbers or digit strings. Refusals use pydantic's wording.
 */
export function datetime(): p.Type<Date> {
  return {
    parse(v, loc, issues) {
      if (typeof v === "number" && Number.isFinite(v)) return fromUnix(v);
      if (typeof v !== "string") {
        issues.push({
          type: "datetime_type",
          loc,
          msg: "Input should be a valid datetime",
          input: v,
          url: `${URL}datetime_type`,
        });
        return FAIL;
      }
      const s = v.trim();
      if (/^[+-]?\d+(\.\d+)?$/.test(s)) return fromUnix(Number(s));
      if (s.length < 10) return fail(issues, loc, v, "input is too short");
      const d = DATE.exec(s);
      if (d) {
        const date = new Date(`${s}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== s)
          return fail(issues, loc, v, "day value is outside expected range");
        return date;
      }
      const m = DATETIME.exec(s);
      if (!m) {
        if (!/^\d{4}/.test(s)) return fail(issues, loc, v, "invalid character in year");
        return fail(issues, loc, v, "unexpected extra characters at the end of the input");
      }
      const [, y, mo, da, h, mi, se = "00", frac = "", tz] = m;
      if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 59)
        return fail(issues, loc, v, "unexpected extra characters at the end of the input");
      let zone = tz ?? "Z";
      if (zone === "z") zone = "Z";
      if (zone !== "Z" && !zone.includes(":")) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
      const ms = frac.padEnd(3, "0").slice(0, 3);
      const date = new Date(`${y}-${mo}-${da}T${h}:${mi}:${se}.${ms}${zone}`);
      if (Number.isNaN(date.getTime()))
        return fail(issues, loc, v, "day value is outside expected range");
      return date;
    },
  };
}
