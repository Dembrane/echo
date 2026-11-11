import { describe, expect, test } from "bun:test";
import {
  CACHE_VERSION,
  cacheFrom,
  cacheVersion,
  emptyCache,
  FOCAL_BATCH,
  forget,
  isLarge,
  neighbours,
  POSITIONS_CHARS,
  positionKey,
  positionsInput,
  positionsKey,
  prune,
} from "../src/tick/scale";

describe("what a large session keeps between reads", () => {
  test("large means more conversations than the positions cap", () => {
    expect(isLarge(80)).toBe(false);
    expect(isLarge(81)).toBe(true);
  });

  test("positions read a fixed slice, so a growing session does not change a conversation's input", () => {
    const text = "x".repeat(POSITIONS_CHARS + 500);
    expect(positionsInput(text).length).toBe(POSITIONS_CHARS);
    expect(positionsKey("p", positionsInput(text))).toBe(
      positionsKey("p", positionsInput(`${text}more`)),
    );
    expect(positionsKey("p", "a")).not.toBe(positionsKey("p2", "a"));
  });

  test("a kept cache is used under its own prompts, and starts empty when the collisions prompt changes", () => {
    const v1 = cacheVersion("collisions prompt one");
    const kept = { ...emptyCache(v1), checked: ["k1"] };
    expect(cacheFrom(JSON.parse(JSON.stringify(kept)), v1).checked).toEqual(["k1"]);
    const v2 = cacheVersion("collisions prompt two");
    expect(cacheFrom(kept, v2)).toEqual(emptyCache(v2));
    expect(cacheFrom(null, v1)).toEqual(emptyCache(v1));
    // A new verify prompt starts it over too: the kept verdicts were its answers.
    expect(cacheVersion("collisions prompt one", "verify one")).not.toBe(
      cacheVersion("collisions prompt one", "verify two"),
    );
    expect(emptyCache().version).toBe(CACHE_VERSION);
  });

  test("a batch lists its focal positions and each one's nearest, in session order", () => {
    const v = new Map([
      ["a", [1, 0]],
      ["b", [0.9, 0.1]],
      ["c", [0, 1]],
      ["d", [0.1, 0.9]],
      ["e", [0.7, 0.7]],
    ]);
    const all = ["a", "b", "c", "d", "e"];
    expect(neighbours(["a"], v, all, 1)).toEqual(["a", "b"]);
    expect(neighbours(["c", "a"], v, all, 1)).toEqual(["a", "b", "c", "d"]);
    // A position without a vector lists nothing beyond itself.
    expect(neighbours(["z"], v, [...all, "z"], 1)).toEqual(["z"]);
    expect(FOCAL_BATCH).toBe(10);
  });

  test("a vanished position's pairs leave the cache", () => {
    const cache = {
      ...emptyCache(),
      checked: ["k1", "k2", "k3"],
      pairs: {
        "k1|k2": { a: "k1", b: "k2", zero_sum: 0.9, why: "w", named_by: ["k1"] },
        "k2|k3": { a: "k2", b: "k3", zero_sum: 0.8, why: "w", named_by: ["k3"] },
      },
    };
    prune(cache, new Set(["k1", "k2"]));
    expect(cache.checked).toEqual(["k1", "k2"]);
    expect(Object.keys(cache.pairs)).toEqual(["k1|k2"]);
  });

  test("a forgotten conversation takes its positions and their pairs along", () => {
    const p = { position: "buses at night", quote: "we need buses at night" };
    const q = { position: "fewer buses", quote: "cut the buses" };
    const [kp, kq] = [positionKey("t1", p), positionKey("t2", q)];
    const cache = {
      ...emptyCache(),
      positions: { t1: { key: "x", found: [p] }, t2: { key: "y", found: [q] } },
      checked: [kp, kq],
      pairs: { [`${kp}|${kq}`]: { a: kp, b: kq, zero_sum: 0.9, why: "w", named_by: [kp] } },
    };
    forget(cache, "t1");
    expect(Object.keys(cache.positions)).toEqual(["t2"]);
    expect(cache.checked).toEqual([kq]);
    expect(cache.pairs).toEqual({});
  });
});
