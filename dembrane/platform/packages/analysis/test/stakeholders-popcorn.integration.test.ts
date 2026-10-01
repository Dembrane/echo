import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FakeCompleter } from "@dembrane/llm";
import type postgres from "postgres";
import type { Json } from "../src/contracts";
import { type ExecutorDeps, execute, requestRun } from "../src/executor";
import { contentHash } from "../src/hashing";
import { POPCORN_SOURCES_KEY, sessionSources } from "../src/recipes";
import { STAKEHOLDERS_PROMPT_TEXT } from "../src/recipes/stakeholders";
import { sha256Hex } from "../src/text";
import { validatePayload, validateRelation } from "../src/types";
import recorded from "./fixtures/python-stakeholders-popcorn.json" with { type: "json" };
import {
  appClient,
  C1,
  dropDatabase,
  executorDeps,
  freshDatabase,
  hasTemplate,
  P1,
} from "./harness";

const DB = `analysis_sp_it_${process.pid}`;
const run = (await hasTemplate()) ? describe : describe.skip;
const S = recorded.stakeholders as unknown as Json;
const P = recorded.popcorn as unknown as Json;

run("stakeholders and popcorn against the seed", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void> = async () => {};
  let deps: ExecutorDeps;
  // The first answer trips the gates; the retry (its prompt carries the flags) is clean.
  const fake = new FakeCompleter((g) => `vertex_ai/fake-${g}`)
    .on("## Your previous answer failed these checks", JSON.stringify(S.retry))
    .on("Stakeholders", JSON.stringify(S.first));

  beforeAll(async () => {
    ({ sql, close } = appClient(await freshDatabase(DB)));
    deps = executorDeps(sql, { completer: fake });
    deps = {
      ...deps,
      services: { ...deps.services, [POPCORN_SOURCES_KEY]: sessionSources(deps.store) },
    };
  });
  afterAll(async () => {
    await close();
    await dropDatabase(DB);
  });

  test("stakeholders asks once, retries with the flags, and publishes Python's objects", async () => {
    const outcome = await requestRun(
      { projectId: P1, recipeId: "stakeholders", scopeKey: "project" },
      deps,
    );
    expect(await execute(deps, outcome.run.id, "lease-sh")).toBe("ready");
    expect(fake.calls.length).toBe(2);
    expect(sha256Hex(String(fake.calls[0]?.system))).toBe(String(S.systemSha));
    expect(fake.calls[0]?.user).toBe(String(S.userText));
    expect(sha256Hex(String(fake.calls[1]?.system))).toBe(String(S.feedbackSha));
    expect(sha256Hex(STAKEHOLDERS_PROMPT_TEXT)).toBe(String(S.systemSha));

    const ready = await deps.store.getRun(outcome.run.id);
    const objects = (ready?.outputManifest?.objects as Json[]) ?? [];
    const relations = (ready?.outputManifest?.relations as Json[]) ?? [];
    const revisions = await deps.store.getRevisions(
      P1,
      objects.map((o) => String(o.revisionId)),
    );
    const want = Object.values(S.payloads as Record<string, Json>)
      .map((p) => String(p.hash))
      .sort();
    const got = [...revisions.values()]
      .map((r) => contentHash(validatePayload("stakeholder", r.payload)))
      .sort();
    expect(got).toEqual(want);
    const rels = await deps.store.getRelations(
      P1,
      relations.map((r) => String(r.relationId)),
    );
    const relHashes = [...rels.values()]
      .map((r) =>
        contentHash(
          validateRelation("stakeholder_relation", {
            fromType: "stakeholder",
            toType: "stakeholder",
            basis: "extracted",
            attributes: r.attributes,
          }),
        ),
      )
      .sort();
    expect(relHashes).toEqual((S.relations as Json[]).map((r) => String(r.hash)).sort());
    const gates = (await deps.store.getSteps(outcome.run.id)).find((s) => s.stepKey === "gates");
    expect(((gates?.output ?? {}) as Json).flags).toEqual(S.flags as string[]);
    expect(((gates?.output ?? {}) as Json).retried).toBe(true);
  });

  test("popcorn publishes one conversation's phrases from its session", async () => {
    await sql.unsafe(
      "INSERT INTO project_report (id, project_id, kind, status, date_created) VALUES (9901, $1, 'popcorn', 'draft', now())",
      [P1],
    );
    const state = {
      conversations: { [C1]: { items: P.items } },
      quotes: Object.values(P.quotes as Json),
    };
    await sql.unsafe(
      "INSERT INTO agent_loop (id, project_id, report_id, expires_at, created_at, popcorn_state) VALUES ($1, $2, 9901, now() + interval '1 day', now(), $3)",
      ["aa000000-0000-4000-8000-000000000001", P1, JSON.stringify(state)],
    );
    const outcome = await requestRun(
      { projectId: P1, recipeId: "popcorn", scopeKey: `conversation:${C1}` },
      deps,
    );
    expect(outcome.run.inputManifest?.phrases).toEqual(P.records as Json[]);
    expect(await execute(deps, outcome.run.id, "lease-pc")).toBe("ready");
    const ready = await deps.store.getRun(outcome.run.id);
    const objects = (ready?.outputManifest?.objects as Json[]) ?? [];
    const revisions = await deps.store.getRevisions(
      P1,
      objects.map((o) => String(o.revisionId)),
    );
    // The seed conversation's createdAt differs from the fixture's, so compare what does not carry it.
    const got = [...revisions.values()].map((r) => String(r.payload.phrase)).sort();
    expect(got).toEqual(
      (P.payloads as Json[]).map((p) => String((p.payload as Json).phrase)).sort(),
    );
    const extras = [...revisions.values()].map((r) => r.provenance.extra ?? {});
    expect(extras.every((e) => e.prompts && e.model)).toBe(true);
  });

  test("popcorn without a session fails with the page's message", async () => {
    const outcome = requestRun(
      {
        projectId: P1,
        recipeId: "popcorn",
        scopeKey: "conversation:c1000000-0000-4000-8000-000000000002",
      },
      deps,
    );
    await expect(outcome).rejects.toThrow("This conversation has no popcorn session to publish.");
  });
});
