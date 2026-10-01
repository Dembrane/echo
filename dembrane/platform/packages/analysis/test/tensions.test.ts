import { expect, test } from "bun:test";
import type { Json } from "../src/contracts";
import { sha256Hex } from "../src/hashing";
import {
  type ArgumentRevision,
  COLLISIONS_SCHEMA,
  completenessFlags,
  runTensions,
  type SourcePassages,
} from "../src/recipes/tensions-pipeline";
import { screenFlags } from "../src/recipes/tensions-stages";
import fixture from "./fixtures/python-tensions-pipeline.json" with { type: "json" };

// The Python pipeline was run on these arguments with a scripted model
// (fixtures/capture-tensions.py); every call it made and its result are in the fixture.
// Replaying the recorded answers by the exact prompt they answered, the port must ask the
// same questions and reach the same result.

const f = fixture as unknown as {
  texts: Record<string, string>;
  arguments: {
    revisionId: string;
    objectId: string;
    kind: string;
    statement: string;
    evidence: [string, string, Json | null][];
  }[];
  calls: { system: string; user: string; thinking: boolean; answer: Json }[];
  result: Json;
  thin: Json;
};

const args: ArgumentRevision[] = f.arguments.map((a) => ({
  revisionId: a.revisionId,
  objectId: a.objectId,
  type: "argument",
  statement: a.statement,
  epistemicKind: a.kind,
  evidence: a.evidence.map(([conversationId, quote, location]) => ({
    conversationId,
    quote,
    location,
  })),
  memberRevisionIds: [],
}));
const sources: SourcePassages[] = Object.keys(f.texts).map((cid, i) => ({
  conversationId: cid,
  label: `Conversation ${i + 1}`,
  transcript: f.texts[cid] as string,
}));

function replay() {
  const asked: string[] = [];
  const generate = async (o: {
    systemPrompt: string;
    userText: string;
    schema: Json;
    thinking: boolean;
  }) => {
    const system = sha256Hex(o.systemPrompt);
    const call = f.calls.find(
      (c) => c.system === system && c.user === o.userText && c.thinking === o.thinking,
    );
    if (!call)
      throw new Error(`no recorded call answers this prompt:\n${o.userText.slice(0, 400)}`);
    asked.push(`${system}\n${o.userText}`);
    return structuredClone(call.answer);
  };
  return { generate, asked };
}

test("the pipeline asks the Python's questions and reaches the Python's result", async () => {
  const { generate, asked } = replay();
  const result = await runTensions(args, sources, { generate, clock: () => 0 });
  expect(asked.sort()).toEqual(f.calls.map((c) => `${c.system}\n${c.user}`).sort());
  expect(JSON.parse(JSON.stringify(result))).toEqual(f.result as never);
});

test("too little evidence is a result without a model call", async () => {
  const { generate, asked } = replay();
  const result = await runTensions(args.slice(0, 2), sources, { generate, clock: () => 0 });
  expect(asked).toEqual([]);
  expect(JSON.parse(JSON.stringify(result))).toEqual(f.thin as never);
});

test("the gates word their flags like the Python's", () => {
  expect(
    completenessFlags({
      id: "x1",
      poleA: "a b c",
      poleB: "a b c",
      knot: "Cars win and and bikes lose",
      toResolve: "Who",
    }),
  ).toEqual([
    "x1 knot: not a finished sentence ending in a full stop: 'Cars win and and bikes lose'",
    "x1 knot: 'and and' repeats a word: 'Cars win and and bikes lose'",
    "x1 toResolve: not a question ending in a question mark: 'Who'",
  ]);
  expect(
    screenFlags([
      {
        id: "x2",
        poleA: "one",
        poleB: "a b c",
        knot: "The participants discussed parking.",
        toResolve: "Why?",
      },
    ]),
  ).toEqual([
    "x2 poleA: 1 words, at least 3: 'one'",
    "x2 knot: reports the meeting ('participants'): 'The participants discussed parking.'",
  ]);
  expect(
    completenessFlags({
      id: "x3",
      knot: "Parking wins; don't, and bikes lose to it",
      toResolve: "Should we or",
    }),
  ).toEqual([
    `x3 knot: not a finished sentence ending in a full stop: "Parking wins; don't, and bikes lose to it"`,
    `x3 knot: an elided clause ("don't"); give every clause its own subject and verb: "Parking wins; don't, and bikes lose to it"`,
    `x3 knot: 'Parking wins' is not a whole clause: "Parking wins; don't, and bikes lose to it"`,
    "x3 toResolve: not a question ending in a question mark: 'Should we or'",
    "x3 toResolve: ends on 'or': 'Should we or'",
  ]);
  expect(COLLISIONS_SCHEMA.required).toEqual(["collisions"]);
});
