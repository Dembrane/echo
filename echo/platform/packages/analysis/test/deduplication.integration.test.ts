import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FakeCompleter } from "@echo/llm";
import type postgres from "postgres";
import type { Json } from "../src/contracts";
import { type ExecutorDeps, execute, requestRun } from "../src/executor";
import {
  appClient,
  dropDatabase,
  executorDeps,
  freshDatabase,
  hasTemplate,
  P1,
  P1_ANSWERS,
} from "./harness";

const DB = `analysis_dedup_it_${process.pid}`;
const run = (await hasTemplate()) ? describe : describe.skip;

/** A recorded-style verifier answer: the first two members merge, the rest stand alone. */
function verifierAnswer(user: string): string {
  const labels = /members: ([^.]+)\./.exec(user)?.[1]?.split(", ") ?? [];
  const [a, b, ...rest] = labels;
  const groups = [
    {
      members: [a, b],
      proposed_statement: "Transport in the city should work later and better.",
      checks: [a, b].map((m) => ({ member: m, judgement: "equivalent", note: "same concern" })),
      verdict: "equivalent",
      rationale: "Both ask for better transport.",
    },
    ...rest.map((m) => ({
      members: [m],
      proposed_statement: "",
      checks: [],
      verdict: "not_equivalent",
      rationale: "Different.",
    })),
  ];
  return JSON.stringify({ groups });
}

run("deduplicated arguments against the seed", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void> = async () => {};
  let deps: ExecutorDeps;
  // The verifier rule comes first: its prompt quotes transcript words the extraction rules key on.
  const fake = new FakeCompleter((g) => `vertex_ai/fake-${g}`).on("A candidate group of", (r) =>
    verifierAnswer(typeof r.user === "string" ? r.user : r.user.join("\n")),
  );
  for (const [needle, answer] of Object.entries(P1_ANSWERS))
    fake.on(needle, JSON.stringify(answer));

  beforeAll(async () => {
    ({ sql, close } = appClient(await freshDatabase(DB)));
    deps = executorDeps(sql, { completer: fake });
  });
  afterAll(async () => {
    await close();
    await dropDatabase(DB);
  });

  test("a request before arguments exist waits on them, then consolidates their output", async () => {
    const outcome = await requestRun(
      {
        projectId: P1,
        recipeId: "deduplicated_arguments",
        scopeKey: "project",
        parameters: { similarity_threshold: 0.5 },
      },
      deps,
    );
    expect(outcome.run.status).toBe("waiting_for_inputs");
    expect(outcome.dependencies.map((r) => r.recipeId)).toEqual(["arguments"]);
    const upstream = outcome.dependencies[0];
    expect(await execute(deps, String(upstream?.id), "lease-args")).toBe("ready");
    const woken = await deps.store.wakeWaitingRuns(P1);
    expect(woken.woken.map((r) => r.id)).toEqual([outcome.run.id]);

    expect(await execute(deps, outcome.run.id, "lease-dedup")).toBe("ready");
    const ready = await deps.store.getRun(outcome.run.id);
    const pinned = ((ready?.inputManifest?.dependencies ?? {}) as Json).arguments as Json;
    expect(pinned.runId).toBe(upstream?.id);
    const objects = (ready?.outputManifest?.objects as Json[]) ?? [];
    const relations = (ready?.outputManifest?.relations as Json[]) ?? [];
    // Three source arguments: one merged pair and one pass-through, each derived from its members.
    expect(objects.length).toBe(2);
    expect(relations.length).toBe(3);
    expect(relations.every((r) => r.type === "derived_from")).toBe(true);
    const revisions = await deps.store.getRevisions(
      P1,
      objects.map((o) => String(o.revisionId)),
    );
    const merged = [...revisions.values()].find(
      (r) => (r.payload.consolidation as Json).memberCount === 2,
    );
    expect(merged?.payload.statement).toBe("Transport in the city should work later and better.");
    expect(((merged?.payload.consolidation ?? {}) as Json).verification).toBe("verified");
    const steps = await deps.store.getSteps(outcome.run.id);
    const assemble = steps.find((s) => s.stepKey === "assemble");
    expect(assemble?.validation.map((v) => v.status)).toEqual(["passed", "passed"]);
  });

  test("a refresh with unchanged arguments reuses the output without another verification", async () => {
    const before = fake.calls.length;
    const outcome = await requestRun(
      {
        projectId: P1,
        recipeId: "deduplicated_arguments",
        scopeKey: "project",
        parameters: { similarity_threshold: 0.5 },
      },
      deps,
    );
    expect(outcome.outcome).toBe("reused");
    expect(fake.calls.length).toBe(before);
  });
});
