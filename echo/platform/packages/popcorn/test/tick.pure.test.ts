import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../src/py";
import {
  applyResults,
  evidenceFrom,
  hedgeAdded,
  kindFrom,
  questionOk,
} from "../src/tick/enrichment";
import {
  gateItems,
  introducedNames,
  jaccard,
  knownShingles,
  nameHits,
  negated,
  scrubNames,
} from "../src/tick/flags";
import { islandFlags, nameFlags, screenFlags } from "../src/tick/gates";
import { groundItems } from "../src/tick/grounding";
import {
  carryForward,
  commitViews,
  fingerprint,
  labelsFor,
  modelWindow,
  selectedAnalysisViews,
  staleViews,
} from "../src/tick/run";
import { allocateChars, QuoteBook, shapePopcornItems, shapeStakeholders } from "../src/tick/shapes";

// Every case was produced by the Python functions the tick ports (fixtures/tick/gen/
// tick_pure.py, run with echo main's server); each must come out the same here.
type Case = { in: unknown; out: unknown };
const fixtures = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "tick", "pure.json"), "utf8"),
) as Record<string, Case[]>;
const cases = (name: string) => fixtures[name] ?? [];
/** Through JSON, as the Python fixture was written: floats kept as floats print as numbers. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const map = (o: unknown) => new Map(Object.entries(o as Record<string, string>));

describe("tick parts match the Python", () => {
  test("fingerprints, windows and labels", () => {
    for (const c of cases("fingerprint")) expect(fingerprint(c.in as string)).toBe(c.out as string);
    for (const c of cases("model_window")) {
      const [t, cap] = c.in as [string, number];
      expect(modelWindow(t, cap)).toBe(c.out as string);
    }
    for (const c of cases("labels_for")) {
      const [name, i] = c.in as [string | null, number];
      expect(labelsFor(name, i)).toEqual(c.out as [string, string]);
    }
  });

  test("names, twins and text the room was shown", () => {
    for (const c of cases("introduced_names"))
      expect([...introducedNames(c.in as string)].sort()).toEqual(c.out as string[]);
    for (const c of cases("name_hits")) {
      const [text, names] = c.in as [string, string[]];
      expect(nameHits(text, new Set(names))).toEqual(c.out as string[]);
    }
    for (const c of cases("scrub_names")) {
      const [text, names] = c.in as [string, string[]];
      expect(scrubNames(text, new Set(names))).toBe(c.out as string);
    }
    for (const c of cases("jaccard")) {
      const [a, b] = c.in as [string, string];
      expect(jaccard(a, b)).toBeCloseTo(c.out as number, 12);
    }
    for (const c of cases("negated")) expect(negated(c.in as string)).toBe(c.out as boolean);
    for (const c of cases("known_shingles")) {
      const [state, exclude] = c.in as [Json, string | null];
      expect([...knownShingles(state, 6, exclude ?? undefined)].sort()).toEqual(c.out as string[]);
    }
    // Python returns whichever shared run its set iterates first (hash order, random per
    // process); any shared run is a Python answer, so the run itself is checked apart.
    const run = /\(('[^']*')\)$/;
    const loose = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/\('[^']*'\)"/g, '(RUN)"'));
    for (const c of cases("gate_items")) {
      const [items, names, known] = c.in as [Json[], string[], string[]];
      const got = gateItems(structuredClone(items), new Set(names), new Set(known));
      expect(loose(got)).toEqual(loose(c.out));
      for (const s of got[1]) {
        const m = run.exec(String(s.reason));
        if (m) expect(known).toContain((m[1] as string).slice(1, -1).split(" ").join("\u0001"));
      }
    }
  });

  test("the slide gates", () => {
    for (const c of cases("name_flags")) expect(nameFlags(c.in as Json)).toEqual(c.out as string[]);
    for (const c of cases("island_flags"))
      expect(islandFlags(c.in as Json)).toEqual(c.out as string[]);
    for (const c of cases("screen_flags"))
      expect(screenFlags(c.in as Json)).toEqual(c.out as string[]);
  });

  test("shaping, grounding and the quote registry", () => {
    for (const c of cases("shape_popcorn_items")) {
      const [raw, tid] = c.in as [unknown, string];
      expect(shapePopcornItems(raw, tid)).toEqual(c.out as Json[]);
    }
    for (const c of cases("ground_items")) {
      const [phrase, transcript] = c.in as [string, string];
      expect(groundItems([{ phrase }], transcript)).toEqual(c.out as Json[]);
    }
    for (const c of cases("quote_book")) {
      const [sources, names, existing, adds] = c.in as [Json, string[], Json[], Json[]];
      const book = new QuoteBook(map(sources), new Set(names), existing);
      const ids = adds.map((q) => book.add(q));
      expect({
        ids,
        quotes: book.quotes,
        rejected: book.rejected,
        reattributed: book.reattributed,
      }).toEqual(c.out as never);
    }
    for (const c of cases("shape_stakeholders")) {
      const [sources, raw] = c.in as [Json, Json];
      const book = new QuoteBook(map(sources));
      const slide = plain(shapeStakeholders(structuredClone(raw), book));
      expect({ slide, quotes: book.quotes }).toEqual(c.out as never);
    }
    for (const c of cases("allocate_chars")) {
      const [lengths, budget] = c.in as [Record<string, number>, number];
      expect(Object.fromEntries(allocateChars(new Map(Object.entries(lengths)), budget))).toEqual(
        c.out as never,
      );
    }
  });

  test("the second pass", () => {
    for (const c of cases("evidence_from")) {
      const [raw, phrase, tr] = c.in as [Json, string, string];
      expect(evidenceFrom(raw, phrase, tr)).toEqual(c.out as never);
    }
    for (const c of cases("kind_from")) {
      const [raw, names] = c.in as [Json, string[]];
      expect(kindFrom(raw, new Set(names))).toEqual(c.out as never);
    }
    for (const c of cases("kind_from_error"))
      expect(() => kindFrom({ kind: c.in }, new Set())).toThrow(c.out as string);
    for (const c of cases("hedge_added")) {
      const [p, q] = c.in as [string, string];
      expect(hedgeAdded(p, q)).toEqual(c.out as string[]);
    }
    for (const c of cases("question_ok")) expect(questionOk(c.in as string)).toBe(c.out as boolean);
    for (const c of cases("apply_results")) {
      const [items, results, reg] = c.in as [Json[], Json[], Record<string, string>];
      const its = structuredClone(items);
      const stats = applyResults(its, results, "c1", (_tid, q) => reg[q] ?? null);
      expect({ items: its, stats }).toEqual(c.out as never);
    }
    for (const c of cases("carry_forward")) {
      const [fresh, entry, text, quotes, fp] = c.in as [Json[], Json, string, Json[], string];
      expect(
        carryForward(structuredClone(fresh), structuredClone(entry), text, quotes, fp),
      ).toEqual(c.out as [Json[], number, number]);
    }
  });

  test("committing views", () => {
    for (const c of cases("commit_views")) {
      const [prev, fresh, held] = c.in as [Json | null, Record<string, Json | null>, string[]];
      const state: Json = { analysis: structuredClone(prev) };
      const outcomes: string[] = [];
      commitViews(state, structuredClone(fresh), "new", new Set(held), outcomes, "NOW");
      const expected = c.out as { analysis: Json | null; outcomes: string[] };
      // The Python stamps its own clock; this run stamps "NOW" in the same places.
      const known = JSON.stringify(prev);
      const stamped = JSON.parse(
        JSON.stringify(expected.analysis ?? null).replace(
          /"(\d{4}-\d\d-\d\dT[^"]+)"/g,
          (m, t: string) => (known.includes(t) ? m : '"NOW"'),
        ),
      );
      expect({ analysis: state.analysis, outcomes }).toEqual({
        analysis: stamped,
        outcomes: expected.outcomes,
      });
    }
    for (const c of cases("stale_views")) {
      const [prev, fp] = c.in as [Json, string];
      const views = fp === "new" ? ["tensions"] : ["tensions", "stakeholders"];
      expect(staleViews({ analysis: prev }, fp, views)).toEqual(c.out as string[]);
    }
    for (const c of cases("selected_views"))
      expect(selectedAnalysisViews(c.in as Json)).toEqual(c.out as string[]);
  });
});
