import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../src/py";
import { promptText } from "../src/tick/model";
import { QuoteBook } from "../src/tick/shapes";
import { PROMPT_NAMES, runPipeline } from "../src/tick/tensions";

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
