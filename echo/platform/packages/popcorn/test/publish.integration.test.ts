import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ExecutorDeps, PRODUCERS_KEY, type ProducerServices } from "@echo/analysis";
import { FakeCompleter } from "@echo/llm";
import type postgres from "postgres";
// The analysis package's own harness and recorded Python answers: the tick publishes
// through the same recipes, so it is checked against the same fixtures.
import recorded from "../../analysis/test/fixtures/python-stakeholders-popcorn.json" with {
  type: "json",
};
import {
  appClient,
  C1,
  C2,
  dropDatabase,
  executorDeps,
  freshDatabase,
  hasTemplate,
  P1,
  quiet,
} from "../../analysis/test/harness";
import { analysisDeck } from "../src/deck";
import type { Json } from "../src/py";
import { Publisher } from "../src/tick/publish";
import { QuoteBook } from "../src/tick/shapes";

const DB = `popcorn_publish_it_${process.pid}`;
const run = (await hasTemplate()) ? describe : describe.skip;
const S = recorded.stakeholders as unknown as Json;
const P = recorded.popcorn as unknown as Json;

run("the tick publishes through the analysis executor", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void> = async () => {};
  let deps: ExecutorDeps;
  const fake = new FakeCompleter((g) => `vertex_ai/fake-${g}`)
    .on("## Your previous answer failed these checks", JSON.stringify(S.retry))
    .on("Stakeholders", JSON.stringify(S.first));

  beforeAll(async () => {
    ({ sql, close } = appClient(await freshDatabase(DB)));
    deps = executorDeps(sql, { completer: fake });
  });
  afterAll(async () => {
    await close();
    await dropDatabase(DB);
  });

  const publisher = (outcomes: string[]) =>
    new Publisher({ executor: deps, deck: analysisDeck(deps.store), logger: quiet }, P1, outcomes);

  test("one conversation's phrases become the popcorn recipe's objects", async () => {
    const outcomes: string[] = [];
    const state = {
      conversations: { [C1]: { items: P.items, label: "Resident 1" } },
      quotes: Object.values(P.quotes as Json),
    };
    await publisher(outcomes).conversation(state, { id: C1, text: P.text });
    expect(outcomes).toEqual([]);
    const [scope] = await sql`select current_run_id from analysis_scope
      where project_id = ${P1} and recipe_id = 'popcorn' and scope_key = ${`conversation:${C1}`}`;
    const ready = await deps.store.getRun(String(scope?.current_run_id));
    expect(ready?.status).toBe("ready");
    const objects = (ready?.outputManifest?.objects as Json[]) ?? [];
    const revisions = await deps.store.getRevisions(
      P1,
      objects.map((o) => String(o.revisionId)),
    );
    expect([...revisions.values()].map((r) => String(r.payload.phrase)).sort()).toEqual(
      (P.payloads as Json[]).map((p) => String((p.payload as Json).phrase)).sort(),
    );
  });

  test("a scope the legacy writer holds is left alone", async () => {
    await sql`insert into analysis_scope (id, project_id, kind, recipe_id, scope_key, next_request_order,
        generation_epoch, publication_sequence, writer, writer_fence, created_at, updated_at)
      values (gen_random_uuid(), ${P1}, 'producer', 'popcorn', ${`conversation:${C2}`}, 1, 0, 0,
        'legacy', 0, now(), now())`;
    const outcomes: string[] = [];
    await publisher(outcomes).conversation(
      { conversations: { [C2]: { items: P.items } }, quotes: [] },
      { id: C2, text: P.text },
    );
    expect(outcomes).toEqual([]);
    const runs = await sql`select 1 from analysis_run r join analysis_scope s on s.id = r.scope_id
      where s.scope_key = ${`conversation:${C2}`}`;
    expect(runs.length).toBe(0);
  });

  test("the stakeholders slide is the recipe's objects, quoted into the session's registry", async () => {
    const producers = deps.services[PRODUCERS_KEY] as ProducerServices;
    const transcripts = (await producers.transcripts(P1)).map((t) => ({
      id: t.id,
      label: t.label,
      created_at: t.createdAt,
      text: t.text,
    }));
    const book = new QuoteBook(new Map(transcripts.map((t) => [t.id, t.text])));
    const outcomes: string[] = [];
    const slide = await publisher(outcomes).stakeholders(transcripts, book);
    expect(outcomes).toEqual([]);
    expect(fake.calls.length).toBe(2);
    const people = (slide?.stakeholders as Json[]) ?? [];
    expect(people.map((p) => p.name).sort()).toEqual(
      ((S.slide as Json).stakeholders as Json[]).map((p) => p.name).sort(),
    );
    // Every quote the slide cites is one the session's book now holds.
    const held = new Set(book.quotes.map((q) => String(q.id)));
    for (const p of people) for (const q of p.quoteIds as string[]) expect(held.has(q)).toBe(true);
    const [deck] = await sql`select 1 from analysis_scope
      where project_id = ${P1} and kind = 'view' and view_id = 'deck' and current_snapshot_id is not null`;
    expect(deck).toBeDefined();
  });
});
