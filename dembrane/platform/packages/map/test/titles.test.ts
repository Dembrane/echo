import { expect, test } from "bun:test";
import { type ObjectRevision, titleLines, titleSelectionKey } from "@dembrane/analysis";
import { FakeCompleter, fakeCalls, takeUnscopedFakeCalls } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { stripQuotes, titleSelection } from "../src/model";
import {
  type SnapshotTarget,
  selectionTitle,
  snapshotSelectionTitle,
  TitleCache,
  type TitleDeps,
  typedTitleLines,
} from "../src/service";
import python from "./python-titles.json" with { type: "json" };

// python-titles.json is the Python map service's output for the same selection, captured
// with its model call replaced by a recorder.
const rev = (
  i: number,
  type: string,
  payload: Record<string, unknown>,
  attributes = {},
): ObjectRevision => ({
  id: `r${i}`,
  objectId: `o${i}`,
  projectId: "p",
  type,
  schemaVersion: 1,
  revisionNumber: 1,
  status: "published",
  payload,
  attributes,
  provenance: { runId: "x", origin: "generated" },
  contentHash: "h",
  hashVersion: "c14n-v1",
  runId: "x",
  parentRevisionId: null,
  embeddingRefs: null,
  actorId: null,
  reason: null,
  changeKind: null,
  createdAt: null,
  publishedAt: null,
});

const revisions = [
  rev(
    1,
    "argument",
    {
      statement: "EV waits are long",
      epistemicKind: "claim",
      evidence: [{ conversationId: "c", quotes: ["q1"] }],
    },
    { epistemicKind: "claim" },
  ),
  rev(2, "tension", {
    poleA: "Cars",
    poleB: "Buses",
    knot: "Late service",
    toResolve: "Who pays?",
  }),
  rev(3, "stakeholder", {
    name: "Residents",
    role: "users",
    stake: "mobility",
    rung: "voiced",
    weight: { stake: 1, mentions: 0.5 },
  }),
  rev(
    4,
    "deduplicated_argument",
    { statement: "Buses should run later", epistemicKind: "argument", consolidation: {} },
    { epistemicKind: "argument" },
  ),
];

test("selection lines, keys and the title prompt match the Python map service", async () => {
  const lines = typedTitleLines(revisions, { r1: "false" }, [
    { from: "r4", to: "r2", type: "supports_pole_b" },
    { from: "r3", to: "r4", type: "custom_link" },
  ]);
  expect(lines).toEqual(python.typed);
  expect(
    titleLines(
      [
        { kind: "claim", claim_key: "k", statement: "A" },
        { kind: "argument", statement: "B" },
        { kind: "claim", claim_key: "z", statement: "C" },
      ],
      { k: "true" },
    ),
  ).toEqual(python.v1);
  expect(titleSelectionKey("res", ["b", "a", "b"], "map-title-v2|m|x")).toBe(python.key);

  const completer = new FakeCompleter().on("Arguments in cluster", '  "A title here" \nmore');
  const title = await withPayer({ ref: "project", id: "p1" }, () =>
    titleSelection(completer, { lines, projectName: " City ", projectContext: "Context x" }),
  );
  expect(title).toBe(python.title);
  expect(completer.calls[0]?.user).toBe(python.user);
  expect(completer.calls[0]?.thinkingBudget).toBe(0);
});

test("a selection title is billed to the map's project, which the route path does not name", async () => {
  const completer = new FakeCompleter().on("Arguments in cluster", "A title here");
  const d = {
    store: { factChecksFor: async () => new Map() },
    rt: {
      store: {
        getRevisions: async (_p: string, ids: string[]) =>
          new Map(revisions.filter((r) => ids.includes(r.id)).map((r) => [r.id, r])),
      },
    },
    cache: new TitleCache(),
    modelIdentity: "m",
    generate: (lines: string[], projectName: string, projectContext: string) =>
      titleSelection(completer, { lines, projectName, projectContext }),
  } as unknown as TitleDeps;
  const row = {
    id: "res",
    project_id: "p-row",
    status: "ready",
    manifest: { arguments: ["a1", "a2", "a3"].map((id) => ({ id, statement: id })) },
  };
  const target = {
    kind: "snapshot",
    resultId: null,
    snapshot: {
      id: "snap",
      projectId: "p-snap",
      manifest: { objects: revisions.map((r) => ({ revisionId: r.id })) },
    },
  } as unknown as SnapshotTarget;
  takeUnscopedFakeCalls();
  await selectionTitle(d, row, ["a1", "a2", "a3"], ["P", ""]);
  await snapshotSelectionTitle(d, target, ["r1", "r2", "r3"], ["P", ""]);
  expect(fakeCalls().map((c) => c.payer)).toEqual([
    { ref: "project", id: "p-row" },
    { ref: "project", id: "p-snap" },
  ]);
});

test("a title is generated once per key, even when asked twice at once", async () => {
  let calls = 0;
  const cache = new TitleCache();
  const produce = async () => {
    calls++;
    await Bun.sleep(10);
    return "One";
  };
  const [a, b] = await Promise.all([cache.once("k", produce), cache.once("k", produce)]);
  expect([a.title, b.title]).toEqual(["One", "One"]);
  expect(calls).toBe(1);
  expect((await cache.once("k", produce)).cached).toBe(true);
});

test("stripQuotes keeps the old edge-quote regex results and is linear", () => {
  const cases: [string, string][] = [
    ["", ""],
    ['"""', ""],
    ['"Title"', "Title"],
    ["“Title”", "Title"],
    ["'a\"b'", 'a"b'],
    ['a"b', 'a"b'],
    ["''", ""],
  ];
  for (const [s, want] of cases) expect(stripQuotes(s)).toBe(want);
  const t = performance.now();
  expect(stripQuotes(`a${'"'.repeat(100_000)}a`)).toBe(`a${'"'.repeat(100_000)}a`);
  expect(performance.now() - t).toBeLessThan(500);
});
