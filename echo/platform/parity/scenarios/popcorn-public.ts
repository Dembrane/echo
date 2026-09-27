import { projects } from "../fixtures";
import { DEMO, pop, session } from "../popcorn-setup";
import { scenarios } from "../runner/scenario";

const pub = (token: string, tail = "/") => `/api/v2/popcorn/public/${token}${tail}`;
const PUBLIC = { public: true };
const FULL = {
  public: true,
  show_qr: true,
  data: { enabled: true },
  notice: { enabled: true, text: "Live" },
  language: { ui: "auto", translate_to: "nl", also: ["de", "fr"] },
};

export default scenarios([
  // ── the page ────────────────────────────────────────────────────────
  {
    name: "popcorn public: page",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token),
    setup: session({ settings: PUBLIC }),
  },
  {
    name: "popcorn public: page without the slash",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, ""),
    setup: session({ settings: PUBLIC }),
  },
  {
    name: "popcorn public: embedded page",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token),
    query: { embedded: "1" },
    setup: session({ settings: PUBLIC }),
  },
  {
    name: "popcorn public: page, not published",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token),
    setup: session(),
  },
  {
    name: "popcorn public: page, unknown token",
    as: "anonymous",
    method: "GET",
    path: pub("unknownToken_000000000"),
  },
  { name: "popcorn public: page, not a token", as: "anonymous", method: "GET", path: pub("short") },
  {
    name: "popcorn public: page, deleted project",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token),
    setup: [
      ...session({ settings: PUBLIC }),
      `update project set deleted_at = now() where id = '${projects.p1}'`,
    ],
  },
  {
    name: "popcorn public: page, deleted report",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token),
    setup: [
      ...session({ settings: PUBLIC }),
      `update project_report set deleted_at = now() where id = ${pop.report}`,
    ],
  },
  {
    name: "popcorn public: logo for any token",
    as: "anonymous",
    method: "GET",
    path: pub("anything", "/logo.png"),
  },
  {
    name: "popcorn public: illustration",
    as: "anonymous",
    method: "GET",
    path: pub("anything", "/illustrations/talk-anon.webp"),
  },
  {
    name: "popcorn public: unknown illustration",
    as: "anonymous",
    method: "GET",
    path: pub("anything", "/illustrations/talk.webp"),
  },

  // ── the room's bundle ───────────────────────────────────────────────
  {
    name: "popcorn public: bundle",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/data/bundle.json"),
    setup: session({ settings: PUBLIC }),
  },
  {
    name: "popcorn public: bundle, every screen",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/data/bundle.json"),
    setup: session({ settings: FULL }),
  },
  {
    name: "popcorn public: bundle, names on the legend",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/data/bundle.json"),
    setup: session({ settings: { public: true, public_labels: "names" } }),
  },
  {
    name: "popcorn public: bundle, synthetic demo",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/data/bundle.json"),
    setup: session({ settings: { public: true, show_qr: true }, state: { demo: DEMO } }),
  },
  {
    name: "popcorn public: bundle, not published",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/data/bundle.json"),
    setup: session(),
  },
  {
    name: "popcorn public: bundle, not a token",
    as: "anonymous",
    method: "GET",
    path: pub("bad token!", "/data/bundle.json"),
  },
  {
    name: "popcorn public: bundle, signed in changes nothing",
    as: "alice",
    method: "GET",
    path: pub(pop.token, "/data/bundle.json"),
    setup: session({ settings: PUBLIC }),
  },

  // ── present on the public link ──────────────────────────────────────
  {
    name: "popcorn public: audience",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/audience"),
    setup: session({ settings: PUBLIC }),
  },
  {
    name: "popcorn public: audience of a presentation",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/audience"),
    setup: session({
      settings: { public: true, presentation: { blocks: ["stakeholders", "popcorn", "map"] } },
    }),
  },
  {
    name: "popcorn public: audience, not published",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/audience"),
    setup: session(),
  },
  {
    name: "popcorn public: map not in the presentation",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/map"),
    setup: session({ settings: PUBLIC }),
  },
  {
    name: "popcorn public: map not made yet",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/map"),
    setup: session({ settings: { public: true, presentation: { blocks: ["map"] } } }),
  },
  {
    name: "popcorn public: map with a bad limit",
    as: "anonymous",
    method: "GET",
    path: pub(pop.token, "/map"),
    query: { node_limit: "many" },
    setup: session({ settings: { public: true, presentation: { blocks: ["map"] } } }),
  },
]);
