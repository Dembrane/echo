import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type EvalPoint, patternRegExp, scorePoints } from "../eval/score";
import { gateItems } from "../src/tick/flags";

const point = (id: string, topic: string[], detail: string[][] = []): EvalPoint => ({
  id,
  says: id,
  topic,
  detail,
});

describe("eval scoring", () => {
  test("a point is kept, thin or missing", () => {
    const points = [
      point("pool", ["pool"], [["29", "twenty.?nine"]]),
      point("letters", ["letter"], [["neighbou?r"]]),
      point("bus", ["bus"]),
    ];
    const got = scorePoints(points, [
      "Promise the pool stays at 29 degrees",
      "Council letters go straight in the recycling",
    ]);
    expect(got.map((r) => r.status)).toEqual(["kept", "thin", "missing"]);
  });

  test("patterns start at a word boundary, and numbers end at one", () => {
    expect(patternRegExp("20").test("by 2035")).toBe(false);
    expect(patternRegExp("20").test("knocks 20 percent off")).toBe(true);
    expect(patternRegExp("4,?000").test("14,000 euros")).toBe(false);
    expect(patternRegExp("car").test("scarce")).toBe(false);
    expect(patternRegExp("demonstrat").test("a demonstration house")).toBe(true);
  });

  test("one phrase answers for one point", () => {
    const points = [point("a", ["street"]), point("b", ["street"])];
    const got = scorePoints(points, ["Do the whole street at once"]);
    expect(got.filter((r) => r.status === "kept")).toHaveLength(1);
  });

  test("a point with one candidate phrase gets it first", () => {
    const points = [point("broad", ["street", "rent"]), point("narrow", ["rent"])];
    const got = scorePoints(points, ["Rent rises after the refit", "Do the whole street at once"]);
    expect(got.map((r) => r.status)).toEqual(["kept", "kept"]);
  });

  test("every case's patterns compile", () => {
    const { cases } = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "eval", "cases.json"), "utf8"),
    ) as { cases: { points: EvalPoint[] }[] };
    for (const c of cases)
      for (const p of c.points)
        for (const pattern of [...p.topic, ...p.detail.flat()])
          expect(() => patternRegExp(pattern)).not.toThrow();
  });
});

describe("the gates keep distinct points", () => {
  test("four points from one submission that share words all pass", () => {
    const phrases = [
      "Do the whole street at once to share the scaffolding",
      "A neighbour at the door works where council letters fail",
      "A voluntary street scheme leaves tenants last on gas",
      "Say before the vote if the pool cannot stay warm",
    ];
    const items = phrases.map((phrase, i) => ({ id: `p${i}`, phrase }));
    const [kept, suppressed] = gateItems(items, new Set(), new Set());
    expect(suppressed).toEqual([]);
    expect(kept).toHaveLength(4);
  });
});
