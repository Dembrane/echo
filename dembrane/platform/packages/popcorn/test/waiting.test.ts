import { describe, expect, test } from "bun:test";
import type { Json } from "../src/py";
import { type PopcornDeps, withWaiting } from "../src/service";

const deps = (waiting: { recording: number; finished: string[] } | Error) =>
  ({
    logger: { warn: () => {} },
    store: {
      waitingConversations: async () => {
        if (waiting instanceof Error) throw waiting;
        return waiting;
      },
    },
  }) as unknown as PopcornDeps;

const bundle = (popcorn: Json = {}): Json => ({
  run: 1,
  files: { "session.json": { title: "Workshop", transcripts: [] }, ...popcorn },
});

describe("the waiting field", () => {
  test("counts the conversations recording and the finished ones still being read", async () => {
    const state = { conversations: { a: { done: true }, b: { done: false } } };
    const out = await withWaiting(
      deps({ recording: 3, finished: ["a", "b", "c"] }),
      bundle({ "popcorn/a.json": { items: [] } }),
      state,
      "p1",
    );
    expect((out.files as Json)["session.json"]).toMatchObject({
      waiting: { being_read: 2, recording: 3 },
    });
  });

  test("leaves the field out once a phrase is up", async () => {
    const out = await withWaiting(
      deps({ recording: 1, finished: [] }),
      bundle({ "popcorn/a.json": { items: [{ phrase: "hello" }] } }),
      {},
      "p1",
    );
    expect(((out.files as Json)["session.json"] as Json).waiting).toBeUndefined();
  });

  test("leaves the bundle standing when the count cannot be read", async () => {
    const before = bundle();
    expect(await withWaiting(deps(new Error("down")), before, {}, "p1")).toBe(before);
  });
});
