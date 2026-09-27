import { type Issue, p, type Type } from "@echo/legacy-shape";
import { settingsBody } from "@echo/popcorn";

/**
 * Present's request shapes, as pydantic declared them. The opening models forbid extra
 * keys: a slide edit may carry only the words a host can type on it, and anything else is
 * refused with pydantic's extra_forbidden entries (declared fields first, then the extras
 * in the order they were sent).
 */

const { model, optional, required, nullable, str, int } = p;

const URL = "https://errors.pydantic.dev/2.12/v/";

/** A model with extra="forbid": the inner model's result, plus one entry per unknown key. */
function forbid<T>(inner: Type<T>, fields: readonly string[]): Type<T> {
  return {
    parse(v, loc, issues) {
      const r = inner.parse(v, loc, issues);
      if (v === null || typeof v !== "object" || Array.isArray(v)) return r;
      let extra = false;
      for (const [k, x] of Object.entries(v)) {
        if (fields.includes(k)) continue;
        extra = true;
        const entry: Issue = {
          type: "extra_forbidden",
          loc: [...loc, k],
          msg: "Extra inputs are not permitted",
          input: x,
          url: `${URL}extra_forbidden`,
        };
        issues.push(entry);
      }
      // Any issue makes the whole request fail; which value stands in does not matter then.
      return extra ? (inner.parse(0, [], []) as T) : r;
    },
  };
}

function nestedForbid<S extends Parameters<typeof model>[0]>(shape: S) {
  const m = model(shape);
  const fields = Object.keys(shape);
  const unwrapped: Type<p.Infer<S>> = {
    parse(v, loc, issues) {
      const r = m.parse(v, loc, issues);
      return typeof r === "object" && r !== null && "data" in r
        ? (r.data as p.Infer<S>)
        : (r as never);
    },
  };
  return forbid(unwrapped, fields);
}

const introWords = nestedForbid({
  title: optional(nullable(str({ max: 160 })), null),
  subtitle: optional(nullable(str({ max: 600 })), null),
});

const disclosureWords = nestedForbid({
  text: optional(nullable(str({ max: 600 })), null),
  invitation_title: optional(nullable(str({ max: 160 })), null),
  invitation_text: optional(nullable(str({ max: 600 })), null),
});

const openingPatch = nestedForbid({
  intro: optional(nullable(introWords), null),
  disclosure: optional(nullable(disclosureWords), null),
});

export const openingBody = nestedForbid({ patch: required(openingPatch) });

export const draftPatchBody = model({
  patch: required(p.nested(settingsBody)),
  expected_revision: required(int({ ge: 0 })),
});

export const draftPublishBody = model({ expected_revision: required(int({ ge: 0 })) });
