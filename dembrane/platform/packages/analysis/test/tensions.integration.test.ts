import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FakeCompleter } from "@dembrane/llm";
import type postgres from "postgres";
import type { Json } from "../src/contracts";
import { type ExecutorDeps, execute, requestRun } from "../src/executor";
import {
  COLLISIONS_SCHEMA,
  SUPPORT_SCHEMA,
  VERIFY_SCHEMA,
  WRITE_SCHEMA,
} from "../src/recipes/tensions-pipeline";
import { DEDUPE_SCHEMA, HANDED_SCHEMA } from "../src/recipes/tensions-stages";
import {
  appClient,
  dropDatabase,
  executorDeps,
  freshDatabase,
  hasTemplate,
  P1,
  P1_ANSWERS,
} from "./harness";

const DB = `analysis_tensions_it_${process.pid}`;
const run = (await hasTemplate()) ? describe : describe.skip;

/** A model that answers every tensions stage by its schema and extraction by its window. */
function fakeModel(): FakeCompleter {
  const fake = new FakeCompleter((g) => `vertex_ai/fake-${g}`);
  const by = (schema: Json) => (r: { jsonSchema?: Record<string, unknown> }) =>
    r.jsonSchema === schema;
  const user = (r: { user: string | readonly string[] }) =>
    typeof r.user === "string" ? r.user : r.user.join("\n");
  fake.on(by(HANDED_SCHEMA), JSON.stringify({ handed: [] }));
  fake.on(by(COLLISIONS_SCHEMA), (r) => {
    const text = user(r);
    const focal = (/FOCAL POSITIONS: (.*)$/m.exec(text)?.[1] ?? "").split(", ");
    const ids = [...text.matchAll(/^(P\d+) \[/gm)].map((m) => m[1] as string);
    return JSON.stringify({
      collisions: focal.map((pid) => ({
        focal: pid,
        other: ids[(ids.indexOf(pid) + 1) % ids.length],
        question: "Who gets the street?",
        why: "they pull against each other",
        zero_sum: 0.8,
      })),
    });
  });
  fake.on(
    by(VERIFY_SCHEMA),
    JSON.stringify({
      valid: true,
      opposed: true,
      question: "How should the street be shared?",
      reason: "one question, opposite answers",
      poleA: "Keep the street for cars",
      poleB: "Give the street to other modes",
    }),
  );
  fake.on(
    by(DEDUPE_SCHEMA),
    JSON.stringify({ same_as: "x1", swapped: false, why: "the same pull" }),
  );
  fake.on(by(SUPPORT_SCHEMA), (r) => {
    const ids = [...user(r).matchAll(/^(P\d+) \[/gm)].map((m) => m[1] as string);
    return JSON.stringify({
      supporters: ids.map((id, i) => ({
        id,
        pole: i === 0 ? "A" : i === 1 ? "B" : "neither",
        strength: 0.9,
        why: "holds it",
      })),
    });
  });
  fake.on(
    by(WRITE_SCHEMA),
    JSON.stringify({
      poleA: "Keep the street for cars",
      poleB: "Give the street to buses",
      knot: "Drivers keep their routes, but late buses and safe lanes lose the road.",
      toResolve: "How much of the street should cars keep?",
    }),
  );
  for (const [needle, answer] of Object.entries(P1_ANSWERS))
    fake.on(needle, JSON.stringify(answer));
  return fake;
}

run("tensions from arguments against the seed", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void> = async () => {};
  let deps: ExecutorDeps;
  const fake = fakeModel();

  beforeAll(async () => {
    ({ sql, close } = appClient(await freshDatabase(DB)));
    deps = executorDeps(sql, { completer: fake });
  });
  afterAll(async () => {
    await close();
    await dropDatabase(DB);
  });

  test("a tensions run waits for its arguments, then publishes tensions with their pole supports", async () => {
    const outcome = await requestRun(
      {
        projectId: P1,
        recipeId: "tensions",
        scopeKey: "project",
        parameters: { input_set: "arguments" },
      },
      deps,
    );
    expect(outcome.run.status).toBe("waiting_for_inputs");
    expect(outcome.dependencies.map((r) => [r.recipeId, r.status])).toEqual([
      ["arguments", "queued"],
    ]);

    const dependency = outcome.dependencies[0];
    expect(await execute(deps, String(dependency?.id), "lease-args")).toBe("ready");
    const woken = await deps.store.wakeWaitingRuns(P1);
    expect(woken.woken.map((r) => r.id)).toEqual([outcome.run.id]);

    expect(await execute(deps, outcome.run.id, "lease-tensions")).toBe("ready");
    const done = await deps.store.getRun(outcome.run.id);
    const objects = (done?.outputManifest?.objects as Json[]) ?? [];
    const relations = (done?.outputManifest?.relations as Json[]) ?? [];
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.every((o) => o.type === "tension")).toBe(true);
    const types = new Set(relations.map((r) => r.type));
    expect(types).toEqual(new Set(["supports_pole_a", "supports_pole_b"]));
    const steps = await deps.store.getSteps(outcome.run.id);
    const review = steps.find((s) => s.stepKey === "review");
    expect(review?.validation.map((v) => [v.check, v.status])).toEqual([
      ["both-poles-supported", "passed"],
      ["support-confirmed", "passed"],
      ["tension-coverage", "passed"],
      ["screen-gate", "passed"],
    ]);
    const revision = (await deps.store.getRevisions(P1, [String(objects[0]?.revisionId)])).get(
      String(objects[0]?.revisionId),
    );
    expect(revision?.payload.knot).toBe(
      "Drivers keep their routes, but late buses and safe lanes lose the road.",
    );
    expect(revision?.embeddingRefs?.embeddingId).toBeTruthy();
  });

  test("a refresh with unchanged arguments reuses every judgement", async () => {
    const before = fake.calls.length;
    const outcome = await requestRun(
      {
        projectId: P1,
        recipeId: "tensions",
        scopeKey: "project",
        parameters: { input_set: "arguments" },
      },
      deps,
    );
    expect(outcome.outcome).toBe("reused");
    expect(fake.calls.length).toBe(before);
  });
});
