// A popcorn session whose stakeholders the analysis executor owns: a ready stakeholders
// output on p1 (two groups and the relation between them), with no deck view yet, so the
// first read of the deck assembles one. Rows satisfy the analysis guard triggers in the
// order they require (scope, run, objects, revisions, heads, relation, current run).

import { contentHash } from "../../packages/analysis/src/hashing";
import { conversations, id, projects, users } from "./fixtures";

const { p1 } = projects;
const { c1, c2 } = conversations;

export const deck = {
  scope: id("5c", 21),
  run: id("5a", 21),
  objects: [id("5b", 21), id("5b", 22)] as const,
  revisions: [id("5e", 21), id("5e", 22)] as const,
  relation: id("5f", 21),
} as const;

const q = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'`;
const context = { model: { group: "MULTI_MODAL_FAST", model: "vertex_ai/gemini-3.8-flash" } };

const quote = (conversationId: string, text: string) => ({
  text,
  conversationId,
  location: null,
});

const payloads = [
  {
    name: "Residents of the flats",
    role: "People who park and charge near the flats",
    stake: "Whether they can charge a car at home at all",
    rung: "voiced",
    weight: { stake: 0.8, mentions: 0.6 },
    quotes: [quote(c1, "the waiting list is months long")],
  },
  {
    name: "Cyclists",
    role: "People who ride to the centre",
    stake: "A safe route past the ring road",
    rung: "voiced",
    weight: { stake: 0.55, mentions: 0.4 },
    quotes: [quote(c2, "the cycle lanes end abruptly at the ring road")],
  },
];

const relationAttributes = {
  label: "compete for road space",
  intensity: 0.5,
  sentiment: -0.25,
  unowned: false,
  detail: "Charging bays and cycle lanes take the same kerb.",
  aspects: [
    {
      kind: "friction",
      note: "the same street",
      quotes: [quote(c2, "the cycle lanes end abruptly at the ring road")],
    },
  ],
};

const objects = deck.objects.map((objectId, i) => ({
  objectId,
  revisionId: deck.revisions[i],
  type: "stakeholder",
}));
const relations = [
  {
    relationId: deck.relation,
    type: "stakeholder_relation",
    from: deck.revisions[0],
    to: deck.revisions[1],
  },
];
const inputManifest = { sources: [], dependencies: {} };
const body = {
  version: 1,
  hashVersion: "c14n-v1",
  recipe: { id: "stakeholders", version: "stakeholders-v1" },
  scope: { id: deck.scope, key: "project" },
  epoch: 0,
  objects,
  relations,
  inputs: { fingerprint: contentHash(inputManifest), revisionIds: [], dependencies: {} },
};
const outputManifest = {
  ...body,
  runId: deck.run,
  checks: [],
  contentHash: contentHash(body),
  publicationSequence: 1,
};

const provenance = (i: number) => ({
  runId: deck.run,
  origin: "generated",
  inputRevisionIds: [],
  sourceRefs: payloads[i]?.quotes.map((qt) => ({
    conversationId: qt.conversationId,
    sourceFingerprint: "a".repeat(64),
    quote: qt.text,
  })),
  recipeId: "stakeholders",
  recipeVersion: "stakeholders-v1",
});

/** The executor owns p1's stakeholders scope and its output is ready; no deck view exists. */
export const STAKEHOLDERS_READY: string[] = [
  `insert into analysis_scope (id, project_id, kind, recipe_id, scope_key, next_request_order, generation_epoch,
     publication_sequence, writer, writer_fence, created_at, updated_at)
   values ('${deck.scope}', '${p1}', 'producer', 'stakeholders', 'project', 2, 0, 1, 'analysis', 0,
     '2026-09-20T11:00:00Z', '2026-09-20T11:05:00Z')`,
  `insert into analysis_run (id, project_id, scope_id, recipe_id, recipe_version, definition, mode, epoch,
     idempotency_key, request_order, request_fingerprint, input_fingerprint, hash_version, input_manifest,
     parameters, context, depends_on, status, progress, attempt, writer_fence, output_manifest, checks, metrics,
     requested_by, created_at, updated_at, started_at, completed_at)
   values ('${deck.run}', '${p1}', '${deck.scope}', 'stakeholders', 'stakeholders-v1', '{}', 'refresh', 0,
     'auto:${id("5a", 121)}', 1, '${"d".repeat(64)}', '${contentHash(inputManifest)}', 'c14n-v1', ${q(inputManifest)},
     '{}', ${q(context)}, '[]', 'ready', '{"stage":"ready"}', 1, 0, ${q(outputManifest)}, '[]',
     '{"modelCalls": 1}', '${users.alice.directus}', '2026-09-20T11:00:00Z',
     '2026-09-20T11:05:00Z', '2026-09-20T11:00:01Z', '2026-09-20T11:05:00Z')`,
  `insert into analysis_request_key (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
   values ('${id("5a", 122)}', '${p1}', 'auto:${id("5a", 121)}', '${deck.run}', '${deck.scope}', 'refresh', '2026-09-20T11:00:00Z')`,
  ...deck.objects.map(
    (o, i) =>
      `insert into analysis_object (id, project_id, type, lineage_key, scope_id, revision_count, created_at, updated_at)
       values ('${o}', '${p1}', 'stakeholder', 'stakeholders/project/name:${String(i).repeat(40)}', '${deck.scope}', 1,
       '2026-09-20T11:04:00Z', '2026-09-20T11:05:00Z')`,
  ),
  ...deck.revisions.map(
    (r, i) =>
      `insert into analysis_object_revision (id, project_id, object_id, revision_number, type, schema_version, status,
         origin, payload, attributes, provenance, content_hash, hash_version, run_id, created_at, published_at)
       values ('${r}', '${p1}', '${deck.objects[i]}', 1, 'stakeholder', 1, 'published', 'generated', ${q(payloads[i])},
         '{}', ${q(provenance(i))}, '${contentHash(payloads[i])}', 'c14n-v1', '${deck.run}',
         '2026-09-20T11:04:0${i}Z', '2026-09-20T11:05:00Z')`,
  ),
  ...deck.objects.map(
    (o, i) =>
      `update analysis_object set current_revision_id = '${deck.revisions[i]}' where id = '${o}'`,
  ),
  `insert into analysis_relation (id, project_id, type, basis, status, from_revision_id, to_revision_id, from_object_id,
     to_object_id, attributes, provenance, content_hash, hash_version, run_id, created_at, published_at)
   values ('${deck.relation}', '${p1}', 'stakeholder_relation', 'extracted', 'published', '${deck.revisions[0]}',
     '${deck.revisions[1]}', '${deck.objects[0]}', '${deck.objects[1]}', ${q(relationAttributes)},
     '{"runId": "${deck.run}"}', '${contentHash(relationAttributes)}', 'c14n-v1', '${deck.run}',
     '2026-09-20T11:05:00Z', '2026-09-20T11:05:00Z')`,
  `update analysis_scope set current_run_id = '${deck.run}', current_request_order = 1 where id = '${deck.scope}'`,
];
