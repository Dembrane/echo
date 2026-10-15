import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../src/py";
import { promptText } from "../src/tick/model";
import { emptyCache, FOCAL_BATCH, positionKey } from "../src/tick/scale";
import { QuoteBook } from "../src/tick/shapes";
import {
  findCollisionsLarge,
  Judge,
  PROMPT_NAMES,
  rankAndCap,
  runPipeline,
} from "../src/tick/tensions";

// The Python pipeline's recorded judgements (fixtures/tick/gen/tick_tensions.py), replayed
// by the words of each request: same requests, same tensions, same quotes, same counts.
interface Call {
  system: string;
  user: string;
  thinking: boolean;
  answer: Json;
}
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "tick", "tensions.json"), "utf8"),
) as { transcripts: Record<string, string>; result: Json; quotes: Json[]; calls: Call[] };

test("the tensions pipeline asks and answers what the Python did", async () => {
  const answers = new Map(fixture.calls.map((c) => [`${c.system}\u0000${c.user}`, c]));
  const asked: string[] = [];
  const book = new QuoteBook(new Map(Object.entries(fixture.transcripts)), new Set(), [
    { id: "q5", transcript: "t1", text: "Parking is already too scarce for residents" },
  ]);
  const result = await runPipeline(new Map(Object.entries(fixture.transcripts)), book, {
    generate: async (o) => {
      const call = answers.get(`${o.system}\u0000${o.user}`);
      if (!call) throw new Error(`no recorded answer: ${o.user.slice(0, 200)}`);
      expect(o.thinking).toBe(call.thinking);
      asked.push(o.user);
      return structuredClone(call.answer);
    },
    prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, promptText(n)])),
    concurrency: 3,
    maxTensions: 3,
  });
  expect(JSON.parse(JSON.stringify(result))).toEqual(fixture.result);
  expect(book.quotes).toEqual(fixture.quotes);
  expect(asked.sort()).toEqual(fixture.calls.map((c) => c.user).sort());
});

test("a judge builds a prompt only when its call starts", async () => {
  let built = 0;
  let finished = 0;
  let peak = 0;
  const judge = new Judge(async () => {
    peak = Math.max(peak, built - finished);
    await Bun.sleep(5);
    finished++;
    return {};
  }, 3);
  await Promise.all(
    Array.from({ length: 30 }, () =>
      judge.call(
        "s",
        () => {
          built++;
          return "u";
        },
        {},
      ),
    ),
  );
  expect(built).toBe(30);
  // Never more prompts alive than slots.
  expect(peak).toBeLessThanOrEqual(3);
});

test("a large session's read stops at the collisions ceiling and says what is left", async () => {
  const texts = new Map(
    Array.from({ length: 700 }, (_, i) => [`t${i}`, `Table ${i} says thing ${i}.`] as const),
  );
  let collisions = 0;
  const result = await runPipeline(texts, new QuoteBook(texts), {
    generate: async (o) => {
      const required = String(o.schema.required);
      if (required === "positions") {
        const n = o.user.match(/id: t(\d+)/)?.[1];
        return {
          positions: [
            { position: `thing ${n}`, holder: "h", kind: "want", hedged: false, quote: "x" },
          ],
        };
      }
      if (required === "collisions") collisions++;
      return {};
    },
    prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, n])),
    large: { cache: emptyCache(), texts, similar: null },
  });
  expect(collisions).toBe(60);
  expect(result.notes?.join(" ")).toContain("100 left for the next read");
});

test("large sessions verify at most forty pairs, small ones every table's best", () => {
  const byId = new Map<string, Json>();
  const pairs: Json[] = [];
  for (let i = 0; i < 300; i++) {
    byId.set(`A${i}`, { id: `A${i}`, transcript: `ta${i}` });
    byId.set(`B${i}`, { id: `B${i}`, transcript: `tb${i}` });
    pairs.push({
      a: `A${i}`,
      b: `B${i}`,
      zero_sum: 0.5 + (i % 50) / 100,
      why: "w",
      cross_table: true,
      named_by: [`A${i}`],
    });
  }
  expect(rankAndCap(pairs, byId, 40, false).length).toBe(40);
  expect(rankAndCap(pairs, byId).length).toBe(300);
});

test("a large session verifies against the text its positions were read from", async () => {
  const filler = "nothing to see here. ".repeat(60);
  const texts = new Map(
    Array.from(
      { length: 2 },
      (_, i) => [`t${i}`, `${filler}Table ${i} says the late quote ${i}.`] as const,
    ),
  );
  // The session's clipped share stops before the quote, as in a session of hundreds.
  const clipped = new Map([...texts].map(([t, x]) => [t, x.slice(0, 200)] as const));
  const verified: string[] = [];
  await runPipeline(clipped, new QuoteBook(texts), {
    generate: async (o) => {
      const required = String(o.schema.required);
      if (required === "positions") {
        const n = o.user.match(/id: t(\d+)/)?.[1];
        return {
          positions: [
            {
              position: `late ${n}`,
              holder: "h",
              kind: "want",
              hedged: false,
              quote: `Table ${n} says the late quote ${n}`,
            },
          ],
        };
      }
      if (required === "collisions")
        return { collisions: [{ focal: "P1", other: "P2", why: "w", zero_sum: 0.9 }] };
      if (required.startsWith("valid")) verified.push(o.user);
      return {};
    },
    prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, n])),
    large: { cache: emptyCache(), texts, similar: null },
  });
  expect(verified.length).toBe(1);
  // The transcripts it reads, not the pair it is shown, must hold the quote.
  expect(verified[0]?.split("WHAT THE ROOMS WERE HANDED")[0]).toContain(
    "Table 0 says the late quote 0",
  );
});

test("a large session verifies a pair once, and a rejected pair makes room for the next", async () => {
  const texts = new Map(
    Array.from({ length: 4 }, (_, i) => [`t${i}`, `Table ${i} says thing ${i}.`] as const),
  );
  const cache = emptyCache();
  const verified: string[] = [];
  const read = (n: number) =>
    runPipeline(new Map([...texts].slice(0, n)), new QuoteBook(texts), {
      generate: async (o) => {
        const required = String(o.schema.required);
        if (required === "positions") {
          const k = o.user.match(/id: t(\d+)/)?.[1];
          return {
            positions: [
              { position: `thing ${k}`, holder: "h", kind: "want", hedged: false, quote: "x" },
            ],
          };
        }
        // Every focal position collides with every other one in its listing.
        if (required === "collisions") {
          const ids = [...o.user.matchAll(/^(P\d+) /gm)].map((m) => m[1] as string);
          const focal = o.user.match(/FOCAL POSITIONS: (.+)$/)?.[1]?.split(", ") ?? [];
          return {
            collisions: focal.flatMap((f) =>
              ids
                .filter((x) => x !== f)
                .map((x) => ({ focal: f, other: x, why: "w", zero_sum: 0.9 })),
            ),
          };
        }
        if (required.startsWith("valid")) {
          verified.push(
            o.user
              .match(/A \(.*\): (thing \d+)[\s\S]*B \(.*\): (thing \d+)/)
              ?.slice(1)
              .sort()
              .join("|") ?? "",
          );
          return { valid: false, why: "no", poleA: "", poleB: "", quotesA: [], quotesB: [] };
        }
        return {};
      },
      prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, n])),
      large: { cache, texts, similar: null },
    });
  await read(3);
  expect(verified.sort()).toEqual(["thing 0|thing 1", "thing 0|thing 2", "thing 1|thing 2"]);
  verified.length = 0;
  // A fourth table: only its pairs are new; the three rejected ones are not asked again.
  await read(4);
  expect(verified.sort()).toEqual(["thing 0|thing 3", "thing 1|thing 3", "thing 2|thing 3"]);
});

test("a large session pairs no position with its own twin, and names a focal once", async () => {
  const texts = new Map([
    ["t0", "Table 0 says buses at night. Table 0 says buses at night."],
    ["t1", "Table 1 says no money for buses."],
  ]);
  const cache = emptyCache();
  let verifies = 0;
  const generate = async (o: { schema: Json; user: string }) => {
    const required = String(o.schema.required);
    if (required === "positions")
      return o.user.includes("id: t0")
        ? {
            positions: [
              {
                position: "buses at night",
                holder: "h",
                kind: "want",
                hedged: false,
                quote: "buses at night",
              },
              {
                position: "buses at night",
                holder: "h",
                kind: "want",
                hedged: false,
                quote: "buses at night",
              },
            ],
          }
        : {
            positions: [
              {
                position: "no money",
                holder: "h",
                kind: "constraint",
                hedged: false,
                quote: "no money",
              },
            ],
          };
    if (required === "collisions")
      return {
        collisions: [
          { focal: "P1", other: "P2", why: "twin", zero_sum: 0.9 },
          { focal: "P1", other: "P3", why: "real", zero_sum: 0.9 },
        ],
      };
    if (required.startsWith("valid")) verifies++;
    return {};
  };
  const opts = {
    generate,
    prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, n])),
    large: { cache, texts, similar: null },
  };
  await runPipeline(texts, new QuoteBook(texts), opts);
  expect(Object.values(cache.pairs).map((p) => p.why)).toEqual(["real"]);
  expect(verifies).toBe(1);
  // Asked again (the position left and came back): it is still named once.
  cache.checked = [];
  for (const p of Object.values(cache.pairs)) delete p.verdict;
  await runPipeline(texts, new QuoteBook(texts), opts);
  for (const p of Object.values(cache.pairs))
    expect(new Set(p.named_by).size).toBe(p.named_by.length);
});

for (const concurrency of [1, 4]) {
  test(`a large session works out a batch's nearest positions only when its call starts (${concurrency} slots)`, async () => {
    const batches = 6;
    const dimensions = 3;
    const positions = Array.from({ length: batches * FOCAL_BATCH }, (_, i) => ({
      id: `P${i + 1}`,
      transcript: `t${i}`,
      position: `thing ${i}`,
      quote: `quote ${i}`,
    }));
    let componentReads = 0;
    let preparingPrompt = false;
    const vectors = new Map(
      positions.map((p, i) => {
        const vector = [i + 1, 1, (i % 3) + 1];
        // Observe the real cosine calculation without mocking the neighbour search or
        // changing production code. Loading embeddings alone reads no components.
        for (let j = 0; j < dimensions; j++) {
          const value = vector[j];
          Object.defineProperty(vector, j, {
            get: () => {
              if (!preparingPrompt)
                throw new Error("Nearest positions were prepared outside the model-call slot");
              componentReads++;
              return value;
            },
          });
        }
        return [p.position, vector] as const;
      }),
    );
    let promptsPrepared = 0;
    let callsStarted = 0;
    const judge = new Judge(async () => {
      callsStarted++;
      expect(promptsPrepared).toBe(callsStarted);
      // Keep each slot occupied across a turn so the remaining batches really queue.
      await Promise.resolve();
      return {};
    }, concurrency);
    const call = judge.call.bind(judge);
    judge.call = (system, user, schema, thinking, label) => {
      expect(typeof user).toBe("function");
      if (typeof user !== "function") throw new Error("Expected a deferred prompt");
      return call(
        system,
        () => {
          const before = componentReads;
          preparingPrompt = true;
          try {
            const text = user();
            // Exercise the real nearest-neighbour calculation, without pinning its exact
            // arithmetic or speed. It may run only while this slot builds its prompt.
            expect(componentReads).toBeGreaterThan(before);
            promptsPrepared++;
            return text;
          } finally {
            preparingPrompt = false;
          }
        },
        schema,
        thinking,
        label,
      );
    };
    const cache = emptyCache();
    await findCollisionsLarge(judge, positions, {
      prompt: "collisions-batch",
      tables: positions.map((p) => p.transcript),
      large: {
        cache,
        texts: new Map(positions.map((p) => [p.transcript, p.quote])),
        similar: async () => vectors,
      },
    });
    expect(callsStarted).toBe(batches);
    expect(promptsPrepared).toBe(batches);
    expect(cache.checked).toHaveLength(positions.length);
  });
}

test("a large session whose embeddings fail lists every position and says why", async () => {
  const texts = new Map(
    Array.from({ length: 3 }, (_, i) => [`t${i}`, `Table ${i} says thing ${i}.`] as const),
  );
  const result = await runPipeline(texts, new QuoteBook(texts), {
    generate: async (o) => {
      if (String(o.schema.required) === "positions") {
        const n = o.user.match(/id: t(\d+)/)?.[1];
        return {
          positions: [
            { position: `thing ${n}`, holder: "h", kind: "want", hedged: false, quote: "x" },
          ],
        };
      }
      return {};
    },
    prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, n])),
    large: {
      cache: emptyCache(),
      texts,
      similar: async () => {
        throw new Error("vertex said no");
      },
    },
  });
  expect(result.notes?.join(" ")).toContain("full listing (embeddings failed: vertex said no)");
});

/** A large session's pipeline over `n` tables whose positions all collide with each other. */
function collidingSession(o: { score?: () => number; verdict?: () => Json; verified?: string[] }) {
  return (texts: ReadonlyMap<string, string>, cache: ReturnType<typeof emptyCache>) =>
    runPipeline(texts, new QuoteBook(texts), {
      generate: async (g) => {
        const required = String(g.schema.required);
        if (required === "positions") {
          const k = g.user.match(/id: t(\d+)/)?.[1];
          return {
            positions: [
              { position: `thing ${k}`, holder: "h", kind: "want", hedged: false, quote: "x" },
            ],
          };
        }
        if (required === "collisions") {
          const ids = [...g.user.matchAll(/^(P\d+) /gm)].map((m) => m[1] as string);
          const focal = g.user.match(/FOCAL POSITIONS: (.+)$/)?.[1]?.split(", ") ?? [];
          return {
            collisions: focal.flatMap((f) =>
              ids
                .filter((x) => x !== f)
                .map((x) => ({ focal: f, other: x, why: "w", zero_sum: o.score?.() ?? 0.9 })),
            ),
          };
        }
        if (required.startsWith("valid")) {
          const pair = [...g.user.matchAll(/: (thing \d+)\n/g)].map((m) => m[1]).sort();
          o.verified?.push(pair.join("|"));
          return (
            o.verdict?.() ?? {
              valid: false,
              why: "no",
              poleA: "",
              poleB: "",
              quotesA: [],
              quotesB: [],
            }
          );
        }
        return {};
      },
      prompts: Object.fromEntries(PROMPT_NAMES.map((n) => [n, n])),
      large: { cache, texts, similar: null },
    });
}
const tables = (n: number) =>
  new Map(Array.from({ length: n }, (_, i) => [`t${i}`, `Table ${i} says thing ${i}.`] as const));

test("a pair found again with a higher score keeps its verdict", async () => {
  const cache = emptyCache();
  const verified: string[] = [];
  let score = 0.6;
  const read = collidingSession({ score: () => score, verified });
  await read(tables(2), cache);
  expect(verified).toEqual(["thing 0|thing 1"]);
  // Asked again (it left and came back) and named more strongly: not verified again.
  cache.checked = [];
  score = 0.95;
  verified.length = 0;
  await read(tables(2), cache);
  expect(verified).toEqual([]);
  expect(Object.values(cache.pairs)[0]?.zero_sum).toBe(0.95);
});

test("pairs verified valid but without quotes do not hold the cap against new pairs", async () => {
  const cache = emptyCache();
  const verified: string[] = [];
  // Valid poles, quotes that are nowhere in the transcripts: unsupported.
  const verdict = () => ({
    valid: true,
    why: "y",
    poleA: "a",
    poleB: "b",
    quotesA: ["nowhere"],
    quotesB: ["nowhere"],
  });
  const read = collidingSession({ verdict, verified });
  await read(tables(10), cache);
  expect(verified.length).toBe(40);
  verified.length = 0;
  // A new table: its nine pairs are verified, the unsupported ones stay out.
  await read(tables(11), cache);
  expect(verified.filter((p) => p.includes("thing 10")).length).toBe(10);
});

test("a large session verifies its strongest pairs, not each table's best", () => {
  const byId = new Map<string, Json>([
    ["P1", { id: "P1", transcript: "t1" }],
    ["P2", { id: "P2", transcript: "t2" }],
    ["P3", { id: "P3", transcript: "t1" }],
    ["P4", { id: "P4", transcript: "t2" }],
    ["P5", { id: "P5", transcript: "t3" }],
    ["P6", { id: "P6", transcript: "t4" }],
  ]);
  const pair = (a: string, b: string, z: number) => ({
    a,
    b,
    zero_sum: z,
    why: "w",
    cross_table: true,
    named_by: [a],
  });
  const pairs = [pair("P1", "P2", 0.9), pair("P3", "P4", 0.95), pair("P5", "P6", 0.3)];
  expect(rankAndCap(pairs, byId, 2, false).map((c) => c.zero_sum)).toEqual([0.95, 0.9]);
  // Small sessions keep every table's best pair.
  expect(
    rankAndCap(pairs, byId, 2)
      .map((c) => c.zero_sum)
      .sort(),
  ).toEqual([0.3, 0.95]);
});

test("a position trimmed out of a read keeps what was found about it", async () => {
  const cache = emptyCache();
  const texts = tables(3);
  await collidingSession({})(texts, cache);
  const before = Object.keys(cache.pairs).length;
  expect(before).toBe(3);
  // The same positions, one left out by this read's trim: nothing about it is forgotten.
  const positions = Object.entries(cache.positions).flatMap(([tid, h]) =>
    h.found.map((p) => ({ ...p, transcript: tid })),
  );
  const listed = positions.slice(0, 2).map((p, i) => ({ id: `P${i + 1}`, ...p }));
  await findCollisionsLarge(new Judge(async () => ({}), 2), listed, {
    prompt: "collisions-batch",
    tables: [...texts.keys()],
    large: { cache, texts, similar: null },
    known: new Set(positions.map((p) => positionKey(String(p.transcript), p))),
  });
  expect(Object.keys(cache.pairs).length).toBe(before);
});
