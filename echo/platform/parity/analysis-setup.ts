// Analysis states the seed does not hold, written as SQL both databases run before a
// request: a ready arguments output on p1 pinned by a map view snapshot, and the host
// state around it (an authored rewording, a withdrawal, last-opened marks, thumbs, a
// fact-check assessment). Every row satisfies the guard triggers of the analysis tables,
// in the order they require (scope, run, objects, revisions, heads, current run).

import { contentHash } from "../packages/analysis/src/hashing";
import recipes from "../packages/analysis/test/fixtures/python-recipes.json" with { type: "json" };
import { conversations, id, projects, users } from "./fixtures";

const { p1 } = projects;
const { c1, c2 } = conversations;

export const ana = {
  argsScope: id("5c", 1),
  viewScope: id("5c", 2),
  tensionsScope: id("5c", 3),
  run: id("5a", 1),
  failedRun: id("5a", 2),
  queuedRun: id("5a", 3),
  objects: [id("5b", 1), id("5b", 2), id("5b", 3)] as const,
  revisions: [id("5e", 1), id("5e", 2), id("5e", 3)] as const,
  edit: id("5e", 4),
  withdrawal: id("5e", 5),
  assessmentObject: id("5b", 9),
  assessment: id("5e", 9),
  assessmentScope: id("5c", 9),
  assessmentRun: id("5a", 9),
  relation: id("5f", 9),
  snapshot: id("5d", 1),
  result: id("5d", 9),
  embeddings: [id("57", 1), id("57", 2), id("57", 3)] as const,
  steps: [id("58", 1), id("58", 2)] as const,
  lastOpened: id("59", 1),
  feedback: id("59", 2),
} as const;

const q = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'`;

const argumentsRecipe = (recipes as Record<string, unknown>[]).find(
  (r) => r.id === "arguments",
) as Record<string, unknown>;
const definition = Object.fromEntries(
  [
    "id",
    "version",
    "hashVersion",
    "inputTypes",
    "outputTypes",
    "steps",
    "validationRules",
    "identityPolicy",
    "embeddingProjections",
  ].map((k) => [k, argumentsRecipe[k]]),
);
const context = { model: { group: "MULTI_MODAL_FAST", model: "vertex_ai/gemini-3.8-flash" } };
const CONFIG_KEY = "c0nf1g0000000000000000000000000000000000000000000000000000000000".slice(0, 64);

const payloads = [
  {
    statement: "The waiting list for charging points near the flats is months long.",
    epistemicKind: "claim",
    valence: "negative",
    evidence: [
      {
        conversationId: c1,
        label: "Resident 1",
        createdAt: "2026-09-27T15:41:55.304Z",
        quotes: ["the waiting list is months long"],
      },
    ],
  },
  {
    statement: "Buses should run later because people drive when buses stop at eleven.",
    epistemicKind: "argument",
    valence: "negative",
    evidence: [
      {
        conversationId: c1,
        label: "Resident 1",
        createdAt: "2026-09-27T15:41:55.304Z",
        quotes: ["Buses stop running at eleven", "people drive even when they would rather not"],
      },
      {
        conversationId: c2,
        label: "Resident 2",
        createdAt: "2026-09-27T15:41:55.310Z",
        quotes: ["the cycle lanes end abruptly"],
      },
    ],
  },
  {
    statement: "Cycle lanes should continue past the ring road.",
    epistemicKind: "argument",
    valence: "negative",
    evidence: [
      {
        conversationId: c2,
        label: "Resident 2",
        createdAt: "2026-09-27T15:41:55.310Z",
        quotes: ["the cycle lanes end abruptly at the ring road"],
      },
    ],
  },
];

const inputManifest = {
  sources: [
    {
      conversationId: c1,
      textHash: "a".repeat(64),
      label: "Resident 1",
      createdAt: "2026-09-27T15:41:55.304Z",
    },
    {
      conversationId: c2,
      textHash: "b".repeat(64),
      label: "Resident 2",
      createdAt: "2026-09-27T15:41:55.310Z",
    },
  ],
  sourceFingerprint: "c".repeat(64),
  embedding: {
    model: "vertex_ai/text-embedding-004",
    baseUrl: "https://europe-west1-aiplatform.googleapis.com",
    apiVersion: null,
    inputNormalization: "collapse-whitespace-v1",
  },
  selectedRevisionIds: [],
  revisionIds: [],
  dependencies: {},
};

const objects = ana.objects.map((objectId, i) => ({
  objectId,
  revisionId: ana.revisions[i],
  type: "argument",
}));

const body = {
  version: 1,
  hashVersion: "c14n-v1",
  recipe: { id: "arguments", version: "arguments-v1" },
  scope: { id: ana.argsScope, key: "project" },
  epoch: 0,
  objects,
  relations: [],
  inputs: { fingerprint: contentHash(inputManifest), revisionIds: [], dependencies: {} },
};
const outputManifest = {
  ...body,
  runId: ana.run,
  checks: [],
  contentHash: contentHash(body),
  publicationSequence: 1,
};

const embeddingConfig = { key: CONFIG_KEY, model: "vertex_ai/text-embedding-004", dims: 3 };

const snapshotBody = {
  version: 1,
  hashVersion: "c14n-v1",
  view: { id: "map", scopeKey: "project" },
  producers: [
    {
      recipeId: "arguments",
      scopeKey: "project",
      scopeId: ana.argsScope,
      runId: ana.run,
      recipeVersion: "arguments-v1",
      manifestHash: outputManifest.contentHash,
      publicationSequence: 1,
      available: true,
    },
  ],
  objects: [...objects].sort((a, b) => (a.objectId < b.objectId ? -1 : 1)),
  relations: [],
  assessments: [],
  stale: [],
  historicalRelations: [],
  embeddingConfig,
  settings: {},
  versions: { mapPayload: 2 },
};
const snapshotManifest = { ...snapshotBody, contentHash: contentHash(snapshotBody) };

const provenance = (i: number) => ({
  runId: ana.run,
  origin: "generated",
  inputRevisionIds: [],
  sourceRefs: (payloads[i]?.evidence ?? []).flatMap((e) =>
    e.quotes.map((quote) => ({
      conversationId: e.conversationId,
      sourceFingerprint: "a".repeat(64),
      quote,
    })),
  ),
  recipeId: "arguments",
  recipeVersion: "arguments-v1",
});

/** A ready arguments output of three argument objects, pinned by the map view's current snapshot. */
export const ARGS_READY: string[] = [
  `insert into analysis_scope (id, project_id, kind, recipe_id, scope_key, next_request_order, generation_epoch,
     publication_sequence, writer, writer_fence, created_at, updated_at)
   values ('${ana.argsScope}', '${p1}', 'producer', 'arguments', 'project', 2, 0, 1, 'analysis', 0,
     '2026-09-20T10:00:00Z', '2026-09-20T10:05:00Z')`,
  `insert into analysis_run (id, project_id, scope_id, recipe_id, recipe_version, definition, mode, epoch,
     idempotency_key, request_order, request_fingerprint, input_fingerprint, hash_version, input_manifest,
     parameters, context, depends_on, status, progress, attempt, writer_fence, output_manifest, checks, metrics,
     requested_by, created_at, updated_at, started_at, completed_at)
   values ('${ana.run}', '${p1}', '${ana.argsScope}', 'arguments', 'arguments-v1', ${q(definition)}, 'refresh', 0,
     'auto:${id("5a", 101)}', 1, '${"d".repeat(64)}', '${contentHash(inputManifest)}', 'c14n-v1', ${q(inputManifest)},
     '{}', ${q(context)}, '[]', 'ready', '{"stage":"ready"}', 1, 0, ${q(outputManifest)}, '[]',
     '{"modelCalls": 2, "wallSeconds": 12.5}', '${users.alice.directus}', '2026-09-20T10:00:00Z',
     '2026-09-20T10:05:00Z', '2026-09-20T10:00:01Z', '2026-09-20T10:05:00Z')`,
  `insert into analysis_request_key (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
   values ('${id("5a", 102)}', '${p1}', 'auto:${id("5a", 101)}', '${ana.run}', '${ana.argsScope}', 'refresh', '2026-09-20T10:00:00Z')`,
  ...ana.embeddings.map(
    (e, i) =>
      `insert into map_embedding (id, project_id, input_hash, config_key, model, dims, embedding, created_at)
       values ('${e}', '${p1}', '${String(i).repeat(64)}', '${CONFIG_KEY}', 'vertex_ai/text-embedding-004', 3,
       '[${[0.25 + i, -0.5, 0.125 * (i + 1)].join(",")}]', '2026-09-20T10:03:00Z')`,
  ),
  ...ana.objects.map(
    (o, i) =>
      `insert into analysis_object (id, project_id, type, lineage_key, scope_id, revision_count, created_at, updated_at)
       values ('${o}', '${p1}', 'argument', 'arguments/project/${i === 2 ? c2 : c1}:c-${i}', '${ana.argsScope}', 1,
       '2026-09-20T10:04:00Z', '2026-09-20T10:05:00Z')`,
  ),
  ...ana.revisions.map(
    (r, i) =>
      `insert into analysis_object_revision (id, project_id, object_id, revision_number, type, schema_version, status,
         origin, payload, attributes, provenance, content_hash, hash_version, run_id, embedding_refs, created_at,
         published_at)
       values ('${r}', '${p1}', '${ana.objects[i]}', 1, 'argument', 1, 'published', 'generated', ${q(payloads[i])},
         ${q({ valence: payloads[i]?.valence, epistemicKind: payloads[i]?.epistemicKind })}, ${q(provenance(i))},
         '${contentHash(payloads[i])}', 'c14n-v1', '${ana.run}',
         ${q({ embeddingId: ana.embeddings[i], inputHash: String(i).repeat(64), configKey: CONFIG_KEY, projectionVersion: "statement-v1" })},
         '2026-09-20T10:04:0${i}Z', '2026-09-20T10:05:00Z')`,
  ),
  ...ana.objects.map(
    (o, i) =>
      `update analysis_object set current_revision_id = '${ana.revisions[i]}' where id = '${o}'`,
  ),
  `update analysis_scope set current_run_id = '${ana.run}', current_request_order = 1 where id = '${ana.argsScope}'`,
  `insert into analysis_step (id, project_id, run_id, step_key, step_version, kind, cache_key, hash_version, status,
     attempt, output, validation, usage, created_at, updated_at, completed_at)
   values ('${ana.steps[0]}', '${p1}', '${ana.run}', 'load', '1', 'deterministic', '${"e".repeat(64)}', 'c14n-v1', 'completed',
     1, '{"conversations": []}', '[{"check": "sources-match-pinned", "status": "passed", "version": "1", "evidence": {"conversations": 2}}]',
     '{"modelCalls": 0, "seconds": 0.01}', '2026-09-20T10:00:02Z', '2026-09-20T10:00:02Z', '2026-09-20T10:00:02Z'),
     ('${ana.steps[1]}', '${p1}', '${ana.run}', 'extract:${c1}', '1', 'model', '${"f".repeat(64)}', 'c14n-v1', 'completed',
     1, '{"windows": []}', '[]', '{"modelCalls": 1, "prompt_tokens": 1200, "seconds": 4.2}',
     '2026-09-20T10:00:03Z', '2026-09-20T10:00:08Z', '2026-09-20T10:00:08Z')`,
  `insert into analysis_scope (id, project_id, kind, view_id, scope_key, next_request_order, generation_epoch,
     publication_sequence, writer, writer_fence, created_at, updated_at)
   values ('${ana.viewScope}', '${p1}', 'view', 'map', 'project', 1, 0, 1, 'analysis', 0, '2026-09-20T10:06:00Z', '2026-09-20T10:06:00Z')`,
  `insert into analysis_snapshot (id, project_id, scope_id, view_id, manifest_version, manifest, settings, versions,
     embedding_config, content_hash, hash_version, created_at)
   values ('${ana.snapshot}', '${p1}', '${ana.viewScope}', 'map', 1, ${q(snapshotManifest)}, '{}', '{"mapPayload": 2}',
     ${q(embeddingConfig)}, '${snapshotManifest.contentHash}', 'c14n-v1', '2026-09-20T10:06:00Z')`,
  `update analysis_scope set current_snapshot_id = '${ana.snapshot}' where id = '${ana.viewScope}'`,
  `insert into map_result (id, project_id, status, recipe_version, embedding_config, progress, manifest, manifest_version,
     snapshot_id, created_at, updated_at, completed_at)
   values ('${ana.result}', '${p1}', 'ready', 'map-view-v2', ${q(embeddingConfig)}, '{"stage": "ready"}',
     ${q({ version: 2, snapshotId: ana.snapshot })}, 2, '${ana.snapshot}', '2026-09-20T10:06:00Z', '2026-09-20T10:06:00Z',
     '2026-09-20T10:06:00Z')`,
];

/** A failed arguments run after the ready one (a retry target) and nothing in flight. */
export const FAILED_RUN = [
  `update analysis_scope set next_request_order = 3 where id = '${ana.argsScope}'`,
  `insert into analysis_run (id, project_id, scope_id, recipe_id, recipe_version, definition, mode, epoch,
     idempotency_key, request_order, request_fingerprint, hash_version, parameters, context, depends_on, status,
     progress, attempt, writer_fence, error, created_at, updated_at, completed_at)
   values ('${ana.failedRun}', '${p1}', '${ana.argsScope}', 'arguments', 'arguments-v1', ${q(definition)}, 'regenerate',
     1, 'auto:${id("5a", 103)}', 2, '${"9".repeat(64)}', 'c14n-v1', '{}', ${q(context)}, '[]', 'failed',
     '{"stage": "failed"}', 1, 0, 'Running the recipe failed.', '2026-09-21T10:00:00Z', '2026-09-21T10:01:00Z',
     '2026-09-21T10:01:00Z')`,
  `insert into analysis_request_key (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
   values ('${id("5a", 104)}', '${p1}', 'auto:${id("5a", 103)}', '${ana.failedRun}', '${ana.argsScope}', 'regenerate', '2026-09-21T10:00:00Z')`,
];

/** A queued run (cancellable) after the ready one. */
export const QUEUED_RUN = [
  `update analysis_scope set next_request_order = 3 where id = '${ana.argsScope}'`,
  `insert into analysis_run (id, project_id, scope_id, recipe_id, recipe_version, definition, mode, epoch,
     idempotency_key, request_order, request_fingerprint, hash_version, parameters, context, depends_on, status,
     progress, attempt, writer_fence, created_at, updated_at)
   values ('${ana.queuedRun}', '${p1}', '${ana.argsScope}', 'arguments', 'arguments-v1', ${q(definition)}, 'regenerate',
     1, 'client:parity-key-queued', 2, '${"8".repeat(64)}', 'c14n-v1', '{}', ${q(context)}, '[]', 'queued',
     '{"stage": "queued"}', 0, 0, '2026-09-21T11:00:00Z', '2026-09-21T11:00:00Z')`,
  `insert into analysis_request_key (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
   values ('${id("5a", 105)}', '${p1}', 'client:parity-key-queued', '${ana.queuedRun}', '${ana.argsScope}', 'regenerate', '2026-09-21T11:00:00Z')`,
];

/** Bob (org B) rewords object 2 as a host would have, before alice last opened the list. */
export const EDITED = [
  `update analysis_scope set publication_sequence = 2 where id = '${ana.argsScope}'`,
  `update analysis_object set revision_count = 2 where id = '${ana.objects[1]}'`,
  `insert into analysis_object_revision (id, project_id, object_id, revision_number, type, schema_version, status,
     origin, payload, attributes, provenance, content_hash, hash_version, parent_revision_id, actor_id, reason,
     change_kind, created_at, published_at)
   values ('${ana.edit}', '${p1}', '${ana.objects[1]}', 2, 'argument', 1, 'published', 'authored',
     ${q({ ...payloads[1], statement: "Buses should run past eleven so people can leave the car at home." })},
     ${q({ valence: "negative", epistemicKind: "argument" })},
     ${q({ ...provenance(1), runId: null, origin: "authored", extra: { authoredFrom: ana.revisions[1], before: ana.revisions[1] } })},
     '${"7".repeat(64)}', 'c14n-v1', '${ana.revisions[1]}', '${users.erin.directus}', 'clearer for the room', 'clarity',
     '2026-09-22T09:00:00Z', '2026-09-22T09:00:00Z')`,
  `update analysis_object set current_revision_id = '${ana.edit}' where id = '${ana.objects[1]}'`,
];

/** Object 3 withdrawn by a host (an authored membership revision). */
export const WITHDRAWN = [
  `update analysis_object set revision_count = 2 where id = '${ana.objects[2]}'`,
  `insert into analysis_object_revision (id, project_id, object_id, revision_number, type, schema_version, status,
     origin, payload, attributes, provenance, content_hash, hash_version, parent_revision_id, actor_id, reason,
     change_kind, created_at, published_at)
   values ('${ana.withdrawal}', '${p1}', '${ana.objects[2]}', 2, 'argument', 1, 'published', 'authored',
     ${q(payloads[2])}, ${q({ valence: "negative", epistemicKind: "argument" })},
     ${q({ ...provenance(2), runId: null, origin: "authored", extra: { authoredFrom: ana.revisions[2], membershipExcluded: true, before: ana.revisions[2] } })},
     '${"6".repeat(64)}', 'c14n-v1', '${ana.revisions[2]}', '${users.alice.directus}', 'repeats another finding', 'withdraw',
     '2026-09-22T10:00:00Z', '2026-09-22T10:00:00Z')`,
  `update analysis_object set current_revision_id = '${ana.withdrawal}' where id = '${ana.objects[2]}'`,
];

/** Alice last opened the results list after the output was published but before the edit. */
export const LAST_OPENED = `insert into analysis_last_opened (id, project_id, user_id, opened_at)
  values ('${ana.lastOpened}', '${p1}', '${users.alice.directus}', '2026-09-21T08:00:00Z')`;

/** Alice's thumb on object 1. */
export const FEEDBACK = `insert into analysis_feedback (id, project_id, object_id, revision_id, actor_id, rating, tags, note, created_at, updated_at)
  values ('${ana.feedback}', '${p1}', '${ana.objects[0]}', '${ana.revisions[0]}', '${users.alice.directus}', 'down',
  '["not_relevant", "other"]', 'too generic', '2026-09-22T11:00:00Z', '2026-09-22T11:00:00Z')`;

/** A published fact-check assessment of the claim (object 1), with its assesses relation. */
export const ASSESSED = [
  `insert into analysis_scope (id, project_id, kind, recipe_id, scope_key, next_request_order, generation_epoch,
     publication_sequence, writer, writer_fence, created_at, updated_at)
   values ('${ana.assessmentScope}', '${p1}', 'producer', 'map.fact_check_assessment', 'revision:${ana.revisions[0]}', 2, 0, 1,
     'analysis', 0, '2026-09-23T10:00:00Z', '2026-09-23T10:00:00Z')`,
  `insert into analysis_run (id, project_id, scope_id, recipe_id, recipe_version, definition, mode, epoch,
     idempotency_key, request_order, request_fingerprint, hash_version, parameters, context, depends_on, status,
     progress, attempt, writer_fence, output_manifest, created_at, updated_at, completed_at)
   values ('${ana.assessmentRun}', '${p1}', '${ana.assessmentScope}', 'map.fact_check_assessment', 'fact-check-assessment-v1',
     '{}', 'refresh', 0, 'map-fact-check:x:1', 1, '${"5".repeat(64)}', 'c14n-v1', '{}', '{"model": {}}', '[]', 'ready',
     '{"stage": "ready"}', 1, 0, '{"objects": []}', '2026-09-23T10:00:00Z', '2026-09-23T10:00:05Z', '2026-09-23T10:00:05Z')`,
  `insert into analysis_object (id, project_id, type, lineage_key, scope_id, revision_count, created_at, updated_at)
   values ('${ana.assessmentObject}', '${p1}', 'fact_check_assessment', 'map.fact_check_assessment/revision:${ana.revisions[0]}/${ana.revisions[0]}',
     '${ana.assessmentScope}', 1, '2026-09-23T10:00:04Z', '2026-09-23T10:00:05Z')`,
  `insert into analysis_object_revision (id, project_id, object_id, revision_number, type, schema_version, status,
     origin, payload, attributes, provenance, content_hash, hash_version, run_id, created_at, published_at)
   values ('${ana.assessment}', '${p1}', '${ana.assessmentObject}', 1, 'fact_check_assessment', 1, 'published', 'generated',
     ${q({ verdict: "contested", justification: "Waiting times vary by district.", sources: [{ url: "https://example.org/ev", title: "EV report" }], statement: payloads[0]?.statement, claimKey: "k".repeat(64) })},
     '{}', ${q({ runId: ana.assessmentRun, origin: "generated", inputRevisionIds: [ana.revisions[0]], sourceRefs: [], recipeId: "map.fact_check_assessment", recipeVersion: "fact-check-assessment-v1" })},
     '${"4".repeat(64)}', 'c14n-v1', '${ana.assessmentRun}', '2026-09-23T10:00:04Z', '2026-09-23T10:00:05Z')`,
  `update analysis_object set current_revision_id = '${ana.assessment}' where id = '${ana.assessmentObject}'`,
  `insert into analysis_relation (id, project_id, type, basis, status, from_revision_id, to_revision_id, from_object_id,
     to_object_id, attributes, provenance, content_hash, hash_version, run_id, created_at, published_at)
   values ('${ana.relation}', '${p1}', 'assesses', 'extracted', 'published', '${ana.assessment}', '${ana.revisions[0]}',
     '${ana.assessmentObject}', '${ana.objects[0]}', '{}', '{"runId": "${ana.assessmentRun}"}', '${"3".repeat(64)}', 'c14n-v1',
     '${ana.assessmentRun}', '2026-09-23T10:00:05Z', '2026-09-23T10:00:05Z')`,
  `update analysis_scope set current_run_id = '${ana.assessmentRun}', current_request_order = 1 where id = '${ana.assessmentScope}'`,
];

/** A ready v1 map result (the shape Map wrote before snapshots), never imported. */
export const LEGACY_V1 = [
  ...ana.embeddings.slice(0, 2).map(
    (e, i) =>
      `insert into map_embedding (id, project_id, input_hash, config_key, model, dims, embedding, created_at)
       values ('${e}', '${p1}', '${String(i + 5).repeat(64)}', '${CONFIG_KEY}', 'vertex_ai/text-embedding-004', 3,
       '[${[1.5 - i, 0.25, -0.75].join(",")}]', '2026-09-10T10:03:00Z')`,
  ),
  `insert into map_result (id, project_id, status, recipe_version, source_fingerprint, embedding_config, progress,
     manifest, manifest_version, requested_by, created_at, updated_at, completed_at)
   values ('${id("5d", 8)}', '${p1}', 'ready', 'map-arguments-v1', '${"2".repeat(64)}', ${q(embeddingConfig)},
     '{"stage": "ready"}', ${q({
       version: 1,
       recipe_version: "map-arguments-v1",
       arguments: [
         {
           id: "a-00000000000000000001",
           statement: "The waiting list for charging points near the flats is months long.",
           kind: "claim",
           valence: "negative",
           claim_key: "1".repeat(64),
           evidence: [
             {
               conversation_id: c1,
               label: "Resident 1",
               created_at: "2026-09-27T15:41:55.304Z",
               quotes: ["the waiting list is months long"],
             },
           ],
           created_at: "2026-09-27T15:41:55.304Z",
           input_hash: "5".repeat(64),
           embedding_id: ana.embeddings[0],
           candidate_ids: ["c-1", "c-2"],
         },
         {
           id: "a-00000000000000000002",
           statement: "Cycle lanes should continue past the ring road.",
           kind: "argument",
           valence: "negative",
           claim_key: null,
           evidence: [
             {
               conversation_id: c2,
               label: "Resident 2",
               created_at: "2026-09-27T15:41:55.310Z",
               quotes: ["the cycle lanes end abruptly at the ring road"],
             },
           ],
           created_at: "2026-09-27T15:41:55.310Z",
           input_hash: "6".repeat(64),
           embedding_id: ana.embeddings[1],
           candidate_ids: ["c-3"],
         },
         {
           id: "a-00000000000000000003",
           statement: "Buses should run later.",
           kind: "argument",
           valence: "negative",
           claim_key: null,
           evidence: [
             {
               conversation_id: c1,
               label: "Resident 1",
               created_at: "2026-09-27T15:41:55.304Z",
               quotes: ["Buses stop running at eleven"],
             },
           ],
           created_at: "2026-09-27T15:41:55.304Z",
           input_hash: "7".repeat(64),
           embedding_id: id("57", 99),
           candidate_ids: [],
         },
       ],
       conversations: [{ id: c1, label: "Resident 1", created_at: "2026-09-27T15:41:55.304Z" }],
       consolidation: {},
       stats: { arguments: 3, conversations: 1 },
     })}, 1, '${users.alice.directus}', '2026-09-10T10:00:00Z', '2026-09-10T10:05:00Z', '2026-09-10T10:05:00Z')`,
];
export const LEGACY_RESULT = id("5d", 8);

/** A check of the claim revision that is running, and one of the v1 claim that finished. */
export const CHECKS = [
  `insert into map_fact_check (id, project_id, claim_key, statement, status, attempt, requested_by, started_at, created_at, updated_at)
   values ('${id("56", 1)}', '${p1}', '${"1".repeat(64)}', 'The waiting list for charging points near the flats is months long.',
     'done', 2, '${users.alice.directus}', '2026-09-24T10:00:00Z', '2026-09-24T10:00:00Z', '2026-09-24T10:01:00Z')`,
  `update map_fact_check set verdict = 'false', justification = 'Waiting lists are weeks.', sources = '[{"url": "https://example.org/a", "title": "A"}]',
     completed_at = '2026-09-24T10:01:00Z', model = 'vertex_ai/gemini-3.8-flash', prompt_version = 'map-factcheck-investigate-v2+map-factcheck-classify-v2'
   where id = '${id("56", 1)}'`,
];
