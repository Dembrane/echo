import { projects, users } from "../fixtures";
import { DEMO, manifest, pop, presentDraft, session } from "../popcorn-setup";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p2, p3 } = projects;
const r = (tail: string, id: number | string = pop.report) => `/api/v2/bff/present/${id}${tail}`;
const WITH_MANIFEST = { settings: { presentation: manifest() } };
const H11 =
  "H-11: publishing a public deck is sharing; it now needs project:share and report:publish (admin or owner, innovator tier)";
const L8 = "L-8: a deck going public gets a fresh link, so one taken down never comes back";

export default scenarios([
  // ── the draft ───────────────────────────────────────────────────────
  {
    name: "present draft: no draft yet",
    as: "alice",
    method: "GET",
    path: r("/draft"),
    setup: session(WITH_MANIFEST),
  },
  {
    name: "present draft: a stored draft",
    as: "alice",
    method: "GET",
    path: r("/draft"),
    setup: session({
      settings: {
        presentation: manifest({ result_bindings: { tensions: "v-published" } }),
        _present_draft: presentDraft(4, {
          presentation: manifest({ result_bindings: { tensions: "old" } }),
        }),
      },
    }),
  },
  {
    name: "present draft: observer",
    as: "rita",
    method: "GET",
    path: r("/draft"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present draft: anonymous",
    as: "anonymous",
    method: "GET",
    path: r("/draft"),
    setup: session(),
  },
  {
    name: "present draft: other tenant",
    as: "bob",
    method: "GET",
    path: r("/draft"),
    setup: session(),
  },
  {
    name: "present draft: not onboarded",
    as: "dave",
    method: "GET",
    path: r("/draft"),
    setup: session(),
  },
  { name: "present draft: missing", as: "alice", method: "GET", path: r("/draft", 99) },
  { name: "present draft: a plain report", as: "alice", method: "GET", path: r("/draft", 1) },

  {
    name: "present draft save: first autosave",
    as: "alice",
    method: "PATCH",
    path: r("/draft"),
    body: {
      patch: { title: "New words", presentation: { blocks: ["stakeholders"] } },
      expected_revision: 0,
    },
    setup: session(WITH_MANIFEST),
  },
  {
    name: "present draft save: on a stored draft",
    as: "alice",
    method: "PATCH",
    path: r("/draft"),
    body: { patch: { language: { translate_to: "nl" } }, expected_revision: 2 },
    setup: session({ settings: { presentation: manifest(), _present_draft: presentDraft(2) } }),
  },
  {
    name: "present draft save: stale revision",
    as: "alice",
    method: "PATCH",
    path: r("/draft"),
    body: { patch: { title: "x" }, expected_revision: 1 },
    setup: session(WITH_MANIFEST),
  },
  {
    name: "present draft save: free tier keeps the mark",
    as: "bob",
    method: "PATCH",
    path: r("/draft"),
    body: { patch: { show_branding: false }, expected_revision: 0 },
    setup: session({ project: p3, owner: users.bob.directus }),
  },
  {
    name: "present draft save: a demo's frame is locked",
    as: "alice",
    method: "PATCH",
    path: r("/draft"),
    body: { patch: { notice: { text: "mine" } }, expected_revision: 0 },
    setup: session({ state: { demo: DEMO } }),
  },
  {
    name: "present draft save: invalid",
    as: "alice",
    method: "PATCH",
    path: r("/draft"),
    body: { patch: { title: "" }, expected_revision: -1 },
    setup: session(),
  },
  {
    name: "present draft save: no patch",
    as: "alice",
    method: "PATCH",
    path: r("/draft"),
    body: { expected_revision: "x" },
    setup: session(),
  },
  {
    name: "present draft save: observer",
    as: "rita",
    method: "PATCH",
    path: r("/draft"),
    body: { patch: { title: "x" }, expected_revision: 0 },
    setup: [P2_OPEN, ...session({ project: p2 })],
  },

  // ── publishing ──────────────────────────────────────────────────────
  {
    name: "present publish: the stored draft",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 2 },
    setup: session({ settings: { presentation: manifest(), _present_draft: presentDraft(2) } }),
  },
  {
    name: "present publish: nothing drafted",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 0 },
    setup: session(WITH_MANIFEST),
  },
  {
    name: "present publish: a new language dispatches a translation",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 1 },
    setup: session({
      settings: {
        presentation: manifest(),
        _present_draft: presentDraft(1, { language: { ui: "auto", translate_to: "de", also: [] } }),
      },
    }),
  },
  {
    name: "present publish: stale revision",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 3 },
    setup: session({ settings: { presentation: manifest(), _present_draft: presentDraft(2) } }),
  },
  {
    name: "present publish: owner makes it public",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 1 },
    setup: session({
      settings: { presentation: manifest(), _present_draft: presentDraft(1, { public: true }) },
    }),
    differs: L8,
  },
  {
    name: "present publish: already public keeps its link",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 1 },
    setup: session({
      settings: {
        public: true,
        presentation: manifest(),
        _present_draft: presentDraft(1, { public: true }),
      },
    }),
  },
  {
    name: "present publish: member makes it public",
    as: "admin",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 1 },
    setup: session({
      settings: { presentation: manifest(), _present_draft: presentDraft(1, { public: true }) },
    }),
    differs: H11,
  },
  {
    name: "present publish: no body",
    as: "alice",
    method: "POST",
    path: r("/publish"),
    setup: session(),
  },
  {
    name: "present publish: other tenant",
    as: "bob",
    method: "POST",
    path: r("/publish"),
    body: { expected_revision: 0 },
    setup: session(),
  },

  // ── opening words, typed on the slide ───────────────────────────────
  {
    name: "present opening: intro words go live",
    as: "alice",
    method: "POST",
    path: r("/opening"),
    body: { patch: { intro: { title: "Good evening", subtitle: null }, disclosure: {} } },
    setup: session(WITH_MANIFEST),
  },
  {
    name: "present opening: a stored draft moves on too",
    as: "alice",
    method: "POST",
    path: r("/opening"),
    body: { patch: { disclosure: { text: "We record", invitation_title: "Join" } } },
    setup: session({ settings: { presentation: manifest(), _present_draft: presentDraft(5) } }),
  },
  {
    name: "present opening: names no field",
    as: "alice",
    method: "POST",
    path: r("/opening"),
    body: { patch: { intro: {} } },
    setup: session(),
  },
  {
    name: "present opening: extra keys",
    as: "alice",
    method: "POST",
    path: r("/opening"),
    body: { patch: { zz: 1, intro: { title: 5, x: 1 }, disclosure: { text: "a" } }, extra: 2 },
    setup: session(),
  },
  {
    name: "present opening: no patch",
    as: "alice",
    method: "POST",
    path: r("/opening"),
    body: {},
    setup: session(),
  },
  {
    name: "present opening: a demo's frame is locked",
    as: "alice",
    method: "POST",
    path: r("/opening"),
    body: { patch: { disclosure: { text: "mine" } } },
    setup: session({ state: { demo: DEMO } }),
  },
  {
    name: "present opening: observer",
    as: "rita",
    method: "POST",
    path: r("/opening"),
    body: { patch: { intro: { title: "x" } } },
    setup: [P2_OPEN, ...session({ project: p2 })],
  },

  // ── what the draft will show ────────────────────────────────────────
  {
    name: "present draft audience: the draft's bundle",
    as: "alice",
    method: "GET",
    path: r("/draft/audience"),
    setup: session({
      settings: {
        presentation: manifest(),
        _present_draft: presentDraft(1, { tabs: { tensions: false, stakeholders: true } }),
      },
    }),
  },
  {
    name: "present draft audience: observer",
    as: "rita",
    method: "GET",
    path: r("/draft/audience"),
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "present draft map: not in the draft",
    as: "alice",
    method: "GET",
    path: r("/draft/map"),
    setup: session(WITH_MANIFEST),
  },
  {
    name: "present draft map: no map yet",
    as: "alice",
    method: "GET",
    path: r("/draft/map"),
    setup: session({ settings: { presentation: manifest({ blocks: ["popcorn", "map"] }) } }),
  },
  {
    name: "present draft map: budgets refused",
    as: "alice",
    method: "GET",
    path: r("/draft/map"),
    query: { node_limit: "10", edge_limit: "3" },
    setup: session({ settings: { presentation: manifest({ blocks: ["map"] }) } }),
  },
  {
    name: "present draft map: not a number",
    as: "alice",
    method: "GET",
    path: r("/draft/map"),
    query: { node_limit: "x" },
    setup: session(),
  },
]);
