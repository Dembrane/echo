// Run by test-preload.test.ts in a child `bun test`; never matched by the suite itself.
import { expect, test } from "bun:test";
import { FakeCompleter, FakeEmbedder, fakeModels } from "../../packages/llm/src";
import { withPayer } from "../../packages/observability/src";

const ask = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
};
const project = { ref: "project", id: "p1" } as const;
const boom = () => {
  throw new Error("metering is broken");
};

test("unscoped model call", async () => {
  await fakeModels().model("multi_modal_pro").doGenerate(ask);
});

test("unscoped completer call", async () => {
  await new FakeCompleter().on("hi", "ok").complete({ group: "text_fast", user: "hi" });
});

test("scoped calls", async () => {
  await withPayer(project, async () => {
    await fakeModels().model("multi_modal_pro").doGenerate(ask);
    await new FakeEmbedder().embed("a");
  });
});

test("observer fault", async () => {
  await withPayer(project, () => fakeModels({ observe: boom }).model("text_fast").doGenerate(ask));
});

test("the next fault reaches its sink again", async () => {
  const faults: unknown[] = [];
  await withPayer(project, () =>
    fakeModels({ observe: boom, onObserverFault: (e) => faults.push(e) })
      .model("text_fast")
      .doGenerate(ask),
  );
  expect(faults).toHaveLength(1);
});
