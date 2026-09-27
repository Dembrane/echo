import type postgres from "postgres";
import { conversationUrl, markSyntheticFiles, roomFiles } from "./bundle";
import { dict, isRecord, type Json, list, pyRound, pyStr, truthy, unique } from "./py";
import { TOGGLEABLE_TABS } from "./settings";
import { referencedQuoteIds } from "./state";
import { norm } from "./text";

/**
 * The published objects behind the deck, and the seam to the analysis store.
 *
 * Where the analysis executor owns a session's producer scopes, the deck's phrases,
 * tensions and stakeholders are projected from the published revisions (the same objects
 * the Map draws) instead of from the tick's state. `DeckAnalysis` is everything popcorn
 * needs from that store. `sqlDeckAnalysis` reads it directly: snapshots, heads and
 * withdrawals are plain reads. Assembling a missing deck snapshot is a write the analysis
 * package owns; until that package is on this branch, a project whose scopes the executor
 * owns but whose deck view was never assembled answers as an unavailable store, which the
 * deck already survives (it keeps the session's own deck). Next: wire the @echo/analysis
 * snapshot assembly here once port/analysis lands.
 */

export const DECK_RECIPES = ["popcorn", "tensions", "stakeholders"] as const;
const DECK_VIEW_ID = "deck";
const DECK_SCOPE_KEY = "project";

export interface DeckRevision {
  readonly id: string;
  readonly objectId: string;
  readonly type: string;
  readonly payload: Json;
  readonly sourceConversationIds: readonly string[];
  readonly extra: Json;
}

export interface DeckRelation {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly attributes: Json;
}

export interface DeckObjects {
  readonly popcorn: ReadonlyMap<string, DeckRevision[]>;
  readonly tensions: readonly DeckRevision[];
  readonly stakeholders: readonly DeckRevision[];
  readonly relations: readonly DeckRelation[];
  readonly ownsTensions: boolean;
  readonly ownsStakeholders: boolean;
}

export const NO_OBJECTS: DeckObjects = {
  popcorn: new Map(),
  tensions: [],
  stakeholders: [],
  relations: [],
  ownsTensions: false,
  ownsStakeholders: false,
};

export const isEmpty = (o: DeckObjects) =>
  !(o.popcorn.size || o.ownsTensions || o.ownsStakeholders);

/** The store cannot answer; the deck keeps the session's own words. */
export class DeckUnavailable extends Error {}

export interface DeckSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly manifest: Json;
}

export interface DeckAnalysis {
  /** The deck's current (or a pinned) snapshot's objects; empty when the legacy writer owns the session. */
  deckObjects(projectId: string, snapshotId?: string | null): Promise<DeckObjects>;
  /** Objects currently withdrawn from every audience view. */
  excludedObjectIds(projectId: string): Promise<Set<string>>;
  /** The deck view's current snapshot, for adopting results; null when there is none yet. */
  currentDeck(projectId: string): Promise<DeckSnapshot | null>;
  /** Whether the executor owns any deck producer scope of this project. */
  ownsAny(projectId: string): Promise<boolean>;
}

type Sql = postgres.Sql | postgres.TransactionSql;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revision(row: Json): DeckRevision {
  const provenance = isRecord(row.provenance) ? row.provenance : { origin: row.origin };
  return {
    id: String(row.id),
    objectId: String(row.object_id),
    type: String(row.type),
    payload: dict(row.payload),
    sourceConversationIds: list(provenance.sourceRefs).map((r) => pyStr(dict(r).conversationId)),
    extra: dict(provenance.extra),
  };
}

export function sqlDeckAnalysis(sql: Sql): DeckAnalysis {
  const snapshotById = async (id: string): Promise<DeckSnapshot | null> => {
    if (!UUID.test(id)) return null;
    const [r] = await sql`select id, project_id, manifest from analysis_snapshot where id = ${id}`;
    return r
      ? { id: String(r.id), projectId: String(r.project_id), manifest: dict(r.manifest) }
      : null;
  };
  const currentDeck = async (projectId: string): Promise<DeckSnapshot | null> => {
    const [scope] = await sql`select current_snapshot_id from analysis_scope
      where project_id = ${projectId} and kind = 'view' and view_id = ${DECK_VIEW_ID}
        and scope_key = ${DECK_SCOPE_KEY}`;
    if (!scope?.current_snapshot_id) return null;
    return snapshotById(String(scope.current_snapshot_id));
  };
  const ownsAny = async (projectId: string): Promise<boolean> => {
    const rows =
      await sql`select 1 from analysis_scope s join analysis_run r on r.id = s.current_run_id
      where s.project_id = ${projectId} and s.kind = 'producer' and s.writer = 'analysis'
        and s.recipe_id in ${sql([...DECK_RECIPES])} limit 1`;
    return rows.length > 0;
  };
  return {
    currentDeck,
    ownsAny,
    async deckObjects(projectId, snapshotId) {
      let snapshot: DeckSnapshot | null;
      if (snapshotId) {
        snapshot = await snapshotById(snapshotId);
        if (snapshot && snapshot.projectId !== projectId) snapshot = null;
      } else snapshot = await currentDeck(projectId);
      if (snapshot === null && !snapshotId && (await ownsAny(projectId)))
        throw new DeckUnavailable("the deck view has not been assembled");
      if (snapshot === null) return NO_OBJECTS;
      return readDeck(sql, snapshot);
    },
    async excludedObjectIds(projectId) {
      const rows = await sql`select r.object_id, r.provenance from analysis_object o
        join analysis_object_revision r on r.id = o.current_revision_id
        where o.project_id = ${projectId} and r.status = 'published'`;
      return new Set(
        rows
          .filter((r) => truthy(dict(dict(r.provenance).extra).membershipExcluded))
          .map((r) => String(r.object_id)),
      );
    },
  };
}

/** Exactly what a snapshot pins, in manifest order, whatever has been published since. */
async function readDeck(sql: Sql, snapshot: DeckSnapshot): Promise<DeckObjects> {
  const manifest = snapshot.manifest;
  const revisionIds = list(manifest.objects).map((o) => pyStr(dict(o).revisionId));
  const relationIds = [
    ...list(manifest.relations).map((r) => pyStr(dict(r).relationId)),
    ...list(manifest.assessments)
      .map(dict)
      .filter((a) => truthy(a.relationId))
      .map((a) => pyStr(a.relationId)),
  ];
  const wanted = revisionIds.filter((id) => UUID.test(id));
  const revs = wanted.length
    ? await sql`select id, object_id, type, payload, provenance, origin from analysis_object_revision
        where project_id = ${snapshot.projectId} and id in ${sql(wanted)}`
    : [];
  const byId = new Map(revs.map((r) => [String(r.id), revision(r as Json)]));
  const rels = relationIds.filter((id) => UUID.test(id));
  const relRows = rels.length
    ? await sql`select id, from_revision_id, to_revision_id, attributes from analysis_relation
        where project_id = ${snapshot.projectId} and id in ${sql(rels)}`
    : [];
  const relById = new Map(relRows.map((r) => [String(r.id), r]));
  const popcorn = new Map<string, DeckRevision[]>();
  const tensions: DeckRevision[] = [];
  const stakeholders: DeckRevision[] = [];
  for (const id of unique(revisionIds)) {
    const r = byId.get(id);
    if (!r) continue;
    if (r.type === "popcorn") {
      const cid = r.sourceConversationIds.find(Boolean) ?? pyStrOr(r.extra.conversationId);
      if (cid) popcorn.set(cid, [...(popcorn.get(cid) ?? []), r]);
    } else if (r.type === "tension") tensions.push(r);
    else if (r.type === "stakeholder") stakeholders.push(r);
  }
  const relations: DeckRelation[] = [];
  for (const id of unique(relationIds)) {
    const r = relById.get(id);
    if (!r) continue;
    relations.push({
      fromRevisionId: String(r.from_revision_id),
      toRevisionId: String(r.to_revision_id),
      attributes: dict(r.attributes),
    });
  }
  const producers = list(manifest.producers).map(dict);
  return {
    popcorn,
    tensions,
    stakeholders,
    relations,
    ownsTensions: producers.some((p) => p.recipeId === "tensions"),
    ownsStakeholders: producers.some((p) => p.recipeId === "stakeholders"),
  };
}

const pyStrOr = (v: unknown) => (truthy(v) ? pyStr(v) : "");

// ── the deck's own shapes ────────────────────────────────────────────────

/** How a projection mints the quote id the deck resolves. */
export type Register = (quote: Json) => string | null;

/** The registry minted over exactly the quotes the objects cite: one id per conversation and wording. */
export class DeckQuotes {
  readonly entries: Json[] = [];
  private readonly ids = new Map<string, string>();
  readonly add: Register = (quote) => {
    if (!isRecord(quote)) return null;
    const text = pyStrOr(quote.text).trim();
    const conversationId = pyStrOr(quote.conversationId);
    if (!text || !conversationId) return null;
    const key = `${conversationId}\u0000${norm(text)}`;
    const found = this.ids.get(key);
    if (found) return found;
    const id = `q${this.entries.length + 1}`;
    this.ids.set(key, id);
    this.entries.push({ id, transcript: conversationId, text });
    return id;
  };
}

function registerAll(register: Register, quotes: unknown): string[] {
  return list(quotes)
    .filter(isRecord)
    .map((q) => register(q))
    .filter((id): id is string => Boolean(id));
}

function popcornItem(
  r: DeckRevision,
  conversationId: string,
  register: Register,
  sources: Map<string, unknown>,
  host: boolean,
): Json {
  const phrase = pyStr(r.payload.phrase);
  const entry: Json = {
    id: truthy(r.extra.phraseId)
      ? pyStr(r.extra.phraseId)
      : `p-${conversationId}-${r.objectId.slice(0, 8)}`,
    phrase,
    objectId: r.objectId,
    revisionId: r.id,
  };
  if (truthy(r.payload.question)) entry.question = true;
  if (truthy(r.extra.verbatim)) entry.verbatim = true;
  if (truthy(r.extra.kind)) {
    entry.kind = pyStr(r.extra.kind);
    entry.qualifiers = list(r.extra.qualifiers).map((q) => pyStr(q));
  }
  const quoteIds = registerAll(
    register,
    list(r.payload.evidence).flatMap((item) =>
      list(dict(item).quotes).map((quote) => ({
        text: quote,
        conversationId: dict(item).conversationId,
      })),
    ),
  );
  if (quoteIds.length) entry.quoteId = quoteIds[0];
  else if (host && truthy(sources.get(phrase))) entry.source = sources.get(phrase);
  return entry;
}

export function tensionSlide(r: DeckRevision, index: number, register: Register): Json {
  const p = r.payload;
  return {
    id: `x${index}`,
    objectId: r.objectId,
    revisionId: r.id,
    poleA: p.poleA,
    poleB: p.poleB,
    knot: p.knot,
    toResolve: p.toResolve,
    quoteIds: registerAll(register, p.quotes),
  };
}

function stakeholder(r: DeckRevision, index: number, register: Register): Json {
  const p = r.payload;
  const weight = dict(p.weight);
  return {
    id: `s${index}`,
    objectId: r.objectId,
    revisionId: r.id,
    name: p.name,
    role: p.role,
    stake: p.stake,
    quoteIds: registerAll(register, p.quotes),
    evidence: { rung: p.rung },
    weight: {
      stake: pyRound(Number(weight.stake), 2),
      mentions: pyRound(Number(weight.mentions), 2),
    },
  };
}

/** Python's sort on (-stake, name): stable, with str comparison by code point. */
function byStake(a: DeckRevision, b: DeckRevision): number {
  const sa = -(Number(dict(a.payload.weight).stake) || 0);
  const sb = -(Number(dict(b.payload.weight).stake) || 0);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return cmpStr(pyStrOr(a.payload.name), pyStrOr(b.payload.name));
}

export function cmpStr(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const cx = (x[i] as string).codePointAt(0) as number;
    const cy = (y[i] as string).codePointAt(0) as number;
    if (cx !== cy) return cx - cy;
  }
  return x.length - y.length;
}

/** The stakeholders slide, ranked by what is at stake so any run publishes the same order. */
export function stakeholdersSlide(
  people: readonly DeckRevision[],
  relations: readonly DeckRelation[],
  register: Register,
): Json {
  const ordered = [...people].sort(byStake);
  const byRevision = new Map(ordered.map((r, i) => [r.id, i + 1]));
  const slide = ordered.map((r) => stakeholder(r, byRevision.get(r.id) as number, register));
  const byName = new Map(slide.map((e) => [norm(pyStr(e.name)), e.id]));
  ordered.forEach((r, i) => {
    const invoked = r.payload.invokedBy;
    const entry = slide[i] as Json;
    if (truthy(invoked) && byName.has(norm(pyStr(invoked))))
      (entry.evidence as Json).invokedBy = byName.get(norm(pyStr(invoked)));
  });
  const out: Json[] = [];
  for (const relation of relations) {
    const a = byRevision.get(relation.fromRevisionId);
    const b = byRevision.get(relation.toRevisionId);
    if (a === undefined || b === undefined) continue;
    const attrs = relation.attributes;
    const aspects: Json[] = [];
    for (const aspect of list(attrs.aspects).map(dict)) {
      const quoteIds = registerAll(register, aspect.quotes);
      if (!quoteIds.length) continue; // no quote, no aspect: the deck's own rule
      aspects.push({ kind: aspect.kind ?? null, note: aspect.note ?? null, quoteIds });
    }
    out.push({
      id: `r${out.length + 1}`,
      between: [`s${a}`, `s${b}`],
      label: "label" in attrs ? attrs.label : "",
      intensity: pyRound(Number(attrs.intensity || 0), 2),
      sentiment: pyRound(Number(attrs.sentiment || 0), 2),
      unowned: truthy(attrs.unowned),
      detail: "detail" in attrs ? attrs.detail : "",
      aspects,
    });
  }
  return { stakeholders: slide, relations: out };
}

/**
 * The deck's files with every scope the executor owns served from its published
 * revisions. A scope it does not own is left exactly as the session state wrote it.
 */
export function applyPublishedObjects(
  bundle: Json,
  objects: DeckObjects,
  args: { settings: Json; project: Json; host: boolean; adminBaseUrl?: string },
): Json {
  if (isEmpty(objects)) return bundle;
  const files: Json = { ...dict(bundle.files) };
  const quotes = new DeckQuotes();
  const tabs = dict(args.settings.tabs);
  for (const [conversationId, revisions] of objects.popcorn) {
    const name = `popcorn/${conversationId}.json`;
    const current: Json = {
      ...(truthy(files[name])
        ? dict(files[name])
        : { transcript: conversationId, revision: 1, done: true }),
    };
    // The closest passage behind an unrooted phrase is the session's, read beside its phrase.
    const sources = new Map<string, unknown>();
    for (const item of list(current.items))
      if (isRecord(item) && truthy(item.source)) sources.set(pyStr(item.phrase), item.source);
    current.items = revisions.map((r) =>
      popcornItem(r, conversationId, quotes.add, sources, args.host),
    );
    files[name] = current;
  }
  if (objects.ownsTensions && truthy(tabs.tensions ?? true)) {
    const ordered = [...objects.tensions].sort(
      (a, b) =>
        cmpStr(pyStr(a.payload.poleA), pyStr(b.payload.poleA)) || cmpStr(a.objectId, b.objectId),
    );
    files["tensions.json"] = {
      tensions: ordered.map((r, i) => tensionSlide(r, i + 1, quotes.add)),
    };
  }
  if (objects.ownsStakeholders && truthy(tabs.stakeholders ?? true))
    files["stakeholders.json"] = stakeholdersSlide(
      objects.stakeholders,
      objects.relations,
      quotes.add,
    );
  if (quotes.entries.length || "quotes.json" in files) {
    files["quotes.json"] = {
      quotes: quotes.entries.map((q) => {
        const entry: Json = { ...q };
        if (args.host && args.adminBaseUrl)
          entry.url = conversationUrl(args.project, pyStr(q.transcript), args.adminBaseUrl);
        return entry;
      }),
    };
  }
  for (const tab of TOGGLEABLE_TABS) if (!truthy(tabs[tab] ?? true)) delete files[`${tab}.json`];
  return { ...bundle, files: markSyntheticFiles(files) };
}

/**
 * `bundle` without the hidden objects, wherever its files list them, and without the
 * quotes only they carried. A relation leaves with either of its ends.
 */
export function withoutObjects(bundle: Json, hidden: ReadonlySet<string>): Json {
  if (!hidden.size) return bundle;
  const files: Json = {};
  for (const [name, value] of Object.entries(dict(bundle.files)))
    files[name] = isRecord(value) ? { ...value } : value;
  for (const [name, file] of Object.entries(files)) {
    if (!isRecord(file)) continue;
    for (const key of ["items", "tensions", "stakeholders"])
      if (Array.isArray(file[key]))
        file[key] = (file[key] as unknown[]).filter((item) => {
          const it = dict(item);
          const id = "objectId" in it ? it.objectId : it.id;
          return !hidden.has(id as string);
        });
    if (name === "stakeholders.json") {
      const kept = new Set(list(file.stakeholders).map((s) => dict(s).id));
      file.relations = list(file.relations).filter((r) =>
        list(dict(r).between).every((end) => kept.has(end)),
      );
    }
  }
  return { ...bundle, files: withoutOrphanQuotes(files) };
}

/** The registry after a projection: every quote something still on the deck cites. */
function withoutOrphanQuotes(files: Json): Json {
  const registry = files["quotes.json"];
  if (!isRecord(registry) || !Array.isArray(registry.quotes)) return files;
  const cited = new Set<string>();
  for (const [name, file] of Object.entries(files))
    if (name !== "quotes.json") referencedQuoteIds(file, cited);
  const kept = registry.quotes.filter((q) => !isRecord(q) || cited.has(pyStr(q.id)));
  if (kept.length === registry.quotes.length) return files;
  return { ...files, "quotes.json": { ...registry, quotes: kept } };
}

/** Presentation-local hiding never withdraws a shared finding. */
export function curatePresentation(bundle: Json, settings: Json): Json {
  const hidden = new Set(list(dict(settings.presentation).hidden_items).map((x) => pyStr(x)));
  return withoutObjects(bundle, hidden);
}

/**
 * Keep non-live slides on the host-adopted saved version. Pinned quote ids are namespaced,
 * because live popcorn's registry keeps growing.
 */
export async function applyResultBindings(
  bundle: Json,
  args: {
    settings: Json;
    projectId: string | null;
    deck: DeckAnalysis;
    versionFiles: (versionId: string) => Promise<Json | null>;
  },
): Promise<Json> {
  const { settings } = args;
  const bindings = dict(dict(settings.presentation).result_bindings);
  if (!truthy(bindings)) return bundle;
  const files: Json = { ...dict(bundle.files) };
  const quotes = [...list(dict(files["quotes.json"]).quotes)];
  const loaded = new Map<string, Json | null>();
  for (const block of ["stakeholders", "tensions"]) {
    const version = bindings[block];
    if (!truthy(version) || !truthy(dict(settings.tabs)[block])) continue;
    const v = pyStr(version);
    if (!loaded.has(v)) {
      if (v.startsWith("analysis:") && args.projectId) {
        const objects = await args.deck.deckObjects(
          args.projectId,
          v.split(":").slice(1).join(":"),
        );
        loaded.set(
          v,
          dict(
            applyPublishedObjects({ files: {} }, objects, {
              settings,
              project: { id: args.projectId },
              host: false,
            }).files,
          ),
        );
      } else {
        const stored = await args.versionFiles(v);
        loaded.set(v, stored ? roomFiles(stored, settings.public_labels !== "names") : null);
      }
    }
    const pinned = loaded.get(v);
    if (!truthy(pinned) || !pinned) continue;
    const name = `${block}.json`;
    if (!(name in pinned)) {
      delete files[name];
      continue;
    }
    const prefix = `${block}:${v}:`;
    const remap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remap);
      if (!isRecord(value)) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          key === "quoteIds" && Array.isArray(val)
            ? val.map((q) => prefix + pyStr(q))
            : key === "quoteId"
              ? prefix + pyStr(val)
              : remap(val),
        ]),
      );
    };
    files[name] = remap(pinned[name]);
    for (const quote of list(dict(pinned["quotes.json"]).quotes))
      if (truthy(dict(quote).id))
        quotes.push({ ...dict(quote), id: prefix + pyStr(dict(quote).id) });
  }
  files["quotes.json"] = { quotes };
  return { ...bundle, files };
}
