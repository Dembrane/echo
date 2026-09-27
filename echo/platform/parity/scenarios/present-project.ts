import { projects } from "../fixtures";
import { manifest, pop, RUNS, session, versions } from "../popcorn-setup";
import { EMPTY_PROJECT, extra, P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, legacy } = projects;
const r = (tail: string, id: number | string = pop.report) => `/api/v2/bff/present/${id}${tail}`;
const proj = (id: string, tail = "") => `/api/v2/bff/present/projects/${id}${tail}`;
// A new report mints a random share token on both sides.
const TOKEN = ["public_token"];
const WITH_MAP = {
  settings: { presentation: manifest({ blocks: ["popcorn", "tensions", "map"] }) },
};
const WAITS_FOR_MAP =
  "waits for the map port: requesting a map generation needs @echo/map (port/analysis); until then it answers as an unavailable map store";

export default scenarios([
  // ── the project's presentation ──────────────────────────────────────
  { name: "present project: none yet", as: "alice", method: "GET", path: proj(p1) },
  {
    name: "present project: the presentation",
    as: "alice",
    method: "GET",
    path: proj(p1),
    setup: [
      ...session({ settings: { presentation: manifest({ language_policy: "project" }) } }),
      ...RUNS,
    ],
  },
  {
    name: "present project: translation status",
    as: "alice",
    method: "GET",
    path: proj(p1),
    setup: [
      ...session({ settings: { language: { ui: "auto", translate_to: "nl", also: ["de"] } } }),
      ...RUNS,
    ],
  },
  {
    name: "present project: observer cannot edit",
    as: "rita",
    method: "GET",
    path: proj(p2),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present project: a half-made presentation reads as none",
    as: "alice",
    method: "GET",
    path: proj(p1),
    setup: session({ loop: null }),
  },
  { name: "present project: other tenant", as: "bob", method: "GET", path: proj(p1) },
  { name: "present project: not onboarded", as: "dave", method: "GET", path: proj(legacy) },
  { name: "present project: anonymous", as: "anonymous", method: "GET", path: proj(p1) },
  { name: "present project: not a uuid", as: "alice", method: "GET", path: proj("nope") },

  {
    name: "present default: creates one",
    as: "alice",
    method: "POST",
    path: proj(p1, "/default"),
    ignoreFields: TOKEN,
  },
  {
    name: "present default: keeps a legacy session and adds its manifest",
    as: "alice",
    method: "POST",
    path: proj(p1, "/default"),
    setup: session({ settings: { tabs: { tensions: false, stakeholders: true } } }),
  },
  {
    name: "present default: repairs a half-made one",
    as: "alice",
    method: "POST",
    path: proj(p1, "/default"),
    setup: session({ loop: null }),
  },
  {
    name: "present default: untitled project",
    as: "alice",
    method: "POST",
    path: proj(extra.project, "/default"),
    setup: [
      EMPTY_PROJECT,
      `update project set name = '  ', language = 'nl' where id = '${extra.project}'`,
    ],
    ignoreFields: TOKEN,
  },
  {
    name: "present default: observer",
    as: "rita",
    method: "POST",
    path: proj(p2, "/default"),
    setup: [P2_OPEN],
  },

  {
    name: "present start: a new presentation prepares popcorn",
    as: "alice",
    method: "POST",
    path: proj(p1, "/start"),
    ignoreFields: TOKEN,
  },
  {
    name: "present start: a read session prepares nothing",
    as: "alice",
    method: "POST",
    path: proj(p1, "/start"),
    setup: session({ settings: { presentation: manifest() } }),
  },
  {
    name: "present start: no conversations, nothing prepared",
    as: "alice",
    method: "POST",
    path: proj(extra.project, "/start"),
    setup: [EMPTY_PROJECT],
    ignoreFields: TOKEN,
  },
  {
    name: "present start: adopts the latest saved run",
    as: "alice",
    method: "POST",
    path: proj(p1, "/start"),
    setup: [
      ...session({ settings: { presentation: manifest({ blocks: ["popcorn", "stakeholders"] }) } }),
      ...versions(),
    ],
  },
  { name: "present start: other tenant", as: "bob", method: "POST", path: proj(p1, "/start") },

  // ── what the room sees ──────────────────────────────────────────────
  {
    name: "present audience: the room's bundle",
    as: "alice",
    method: "GET",
    path: r("/audience"),
    setup: session({ settings: { presentation: manifest(), public_labels: "names" } }),
  },
  {
    name: "present audience: observer",
    as: "rita",
    method: "GET",
    path: r("/audience"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present audience: other tenant",
    as: "bob",
    method: "GET",
    path: r("/audience"),
    setup: session(),
  },
  {
    name: "present map: not in the presentation",
    as: "alice",
    method: "GET",
    path: r("/map"),
    setup: session(),
  },
  {
    name: "present map: no map yet",
    as: "alice",
    method: "GET",
    path: r("/map"),
    setup: session(WITH_MAP),
  },
  {
    name: "present map: bound to a snapshot that is gone",
    as: "alice",
    method: "GET",
    path: r("/map"),
    setup: session({
      settings: {
        presentation: manifest({ blocks: ["map"], result_bindings: { map: "not-a-uuid" } }),
      },
    }),
  },
  {
    name: "present map: zero nodes",
    as: "alice",
    method: "GET",
    path: r("/map"),
    query: { node_limit: "0" },
    setup: session(WITH_MAP),
  },

  {
    name: "present deck: host page",
    as: "alice",
    method: "GET",
    path: r("/deck/"),
    setup: session(),
  },
  {
    name: "present deck: preview",
    as: "alice",
    method: "GET",
    path: r("/deck/"),
    query: { preview: "true" },
    setup: session(),
  },
  {
    name: "present deck: bad preview",
    as: "alice",
    method: "GET",
    path: r("/deck/"),
    query: { preview: "maybe" },
    setup: session(),
  },
  {
    name: "present deck: observer",
    as: "rita",
    method: "GET",
    path: r("/deck/"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present draft deck: owner",
    as: "alice",
    method: "GET",
    path: r("/draft/deck/"),
    query: { preview: "1" },
    setup: session(),
  },
  {
    name: "present draft deck: observer",
    as: "rita",
    method: "GET",
    path: r("/draft/deck/"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present deck bundle: owner",
    as: "alice",
    method: "GET",
    path: r("/deck/data/bundle.json"),
    setup: session({ settings: { presentation: manifest({ hidden_items: ["p1"] }) } }),
  },
  {
    name: "present deck bundle: anonymous",
    as: "anonymous",
    method: "GET",
    path: r("/deck/data/bundle.json"),
    setup: session(),
  },
  {
    name: "present draft deck bundle: the draft",
    as: "alice",
    method: "GET",
    path: r("/draft/deck/data/bundle.json"),
    setup: session({
      settings: {
        _present_draft: { revision: 1, settings: { title: "Draft deck", show_qr: true } },
      },
    }),
  },
  {
    name: "present deck logo",
    as: "alice",
    method: "GET",
    path: r("/deck/logo.png"),
    setup: session(),
  },
  {
    name: "present draft deck logo: other tenant",
    as: "bob",
    method: "GET",
    path: r("/draft/deck/logo.png"),
    setup: session(),
  },
  {
    name: "present deck illustration",
    as: "alice",
    method: "GET",
    path: r("/deck/illustrations/scan-dark.webp"),
    setup: session(),
  },
  {
    name: "present draft deck illustration: unknown",
    as: "alice",
    method: "GET",
    path: r("/draft/deck/illustrations/nope.webp"),
    setup: session(),
  },
  {
    name: "present deck illustration: other tenant",
    as: "bob",
    method: "GET",
    path: r("/deck/illustrations/scan.webp"),
    setup: session(),
  },

  // ── adopting results, translating, preparing ────────────────────────
  {
    name: "present adopt: the latest saved run",
    as: "alice",
    method: "POST",
    path: r("/adopt"),
    setup: [
      ...session({
        settings: { presentation: manifest({ blocks: ["popcorn", "tensions", "stakeholders"] }) },
      }),
      ...versions(),
    ],
  },
  {
    name: "present adopt: nothing to adopt",
    as: "alice",
    method: "POST",
    path: r("/adopt"),
    setup: session(WITH_MAP),
  },
  {
    name: "present adopt: observer",
    as: "rita",
    method: "POST",
    path: r("/adopt"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present translate: queued",
    as: "alice",
    method: "POST",
    path: r("/translate"),
    setup: session(),
  },
  {
    name: "present translate: no loop",
    as: "alice",
    method: "POST",
    path: r("/translate"),
    setup: session({ loop: null }),
  },
  {
    name: "present translate: observer",
    as: "rita",
    method: "POST",
    path: r("/translate"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present updates: a newer run",
    as: "alice",
    method: "GET",
    path: r("/updates"),
    setup: [...session({ settings: { presentation: manifest() } }), ...versions()],
  },
  {
    name: "present updates: nothing new",
    as: "rita",
    method: "GET",
    path: r("/updates"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present prepare: popcorn",
    as: "alice",
    method: "POST",
    path: r("/prepare/popcorn"),
    setup: session(),
  },
  {
    name: "present prepare: tensions",
    as: "alice",
    method: "POST",
    path: r("/prepare/tensions"),
    setup: session(WITH_MAP),
  },
  {
    name: "present prepare: not in the presentation",
    as: "alice",
    method: "POST",
    path: r("/prepare/stakeholders"),
    setup: session(WITH_MAP),
  },
  {
    name: "present prepare: map",
    as: "alice",
    method: "POST",
    path: r("/prepare/map"),
    setup: session(WITH_MAP),
    differs: WAITS_FOR_MAP,
  },
  {
    name: "present prepare: observer",
    as: "rita",
    method: "POST",
    path: r("/prepare/popcorn"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
]);
