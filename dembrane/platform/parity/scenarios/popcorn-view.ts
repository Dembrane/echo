import { STAKEHOLDERS_READY } from "../deck-setup";
import { projects } from "../fixtures";
import { DEMO, pop, session, versions } from "../popcorn-setup";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p2 } = projects;
const sample = "/api/v2/bff/popcorn/sample/view";
const view = (tail = "") => `/api/v2/bff/popcorn/${pop.report}/view${tail}`;
const bundle = view("/data/bundle.json");
/** Every screen on: names on the legend, QR, data screen, a translation in progress. */
const FULL = {
  show_qr: true,
  public_labels: "names",
  data: { enabled: true },
  disclosure: { enabled: true, text: "We record", invitation_title: "Join", invitation_text: "" },
  language: { ui: "auto", translate_to: "nl", also: ["de"] },
};

export default scenarios([
  // ── the sample deck ─────────────────────────────────────────────────
  { name: "popcorn sample: page", as: "alice", method: "GET", path: `${sample}/` },
  { name: "popcorn sample: page, anonymous", as: "anonymous", method: "GET", path: `${sample}/` },
  { name: "popcorn sample: bundle", as: "rita", method: "GET", path: `${sample}/data/bundle.json` },
  { name: "popcorn sample: logo", as: "alice", method: "GET", path: `${sample}/logo.png` },
  {
    name: "popcorn sample: illustration",
    as: "alice",
    method: "GET",
    path: `${sample}/illustrations/scan-dark.webp`,
  },
  {
    name: "popcorn sample: unknown illustration",
    as: "alice",
    method: "GET",
    path: `${sample}/illustrations/nope.webp`,
  },

  // ── the host's deck ─────────────────────────────────────────────────
  { name: "popcorn view: page", as: "alice", method: "GET", path: view("/"), setup: session() },
  {
    name: "popcorn view: page with a saved run",
    as: "alice",
    method: "GET",
    path: view("/"),
    query: { version: pop.version },
    setup: session(),
  },
  {
    name: "popcorn view: page with a bad run id",
    as: "alice",
    method: "GET",
    path: view("/"),
    query: { version: "nope" },
    setup: session(),
  },
  {
    name: "popcorn view: page, other tenant",
    as: "bob",
    method: "GET",
    path: view("/"),
    setup: session(),
  },
  {
    name: "popcorn view: flow page",
    as: "alice",
    method: "GET",
    path: view("/flow/"),
    setup: session(),
  },
  {
    name: "popcorn view: logo",
    as: "alice",
    method: "GET",
    path: view("/logo.png"),
    setup: session(),
  },
  {
    name: "popcorn view: illustration",
    as: "alice",
    method: "GET",
    path: view("/illustrations/understand.webp"),
    setup: session(),
  },
  {
    name: "popcorn view: unknown illustration",
    as: "bob",
    method: "GET",
    path: view("/illustrations/x.webp"),
    setup: session(),
  },
  {
    name: "popcorn view: illustration, other tenant",
    as: "bob",
    method: "GET",
    path: view("/illustrations/scan.webp"),
    setup: session(),
  },

  // ── the host's bundle ───────────────────────────────────────────────
  { name: "popcorn bundle: host", as: "alice", method: "GET", path: bundle, setup: session() },
  {
    name: "popcorn bundle: room",
    as: "alice",
    method: "GET",
    path: bundle,
    query: { view: "room" },
    setup: session(),
  },
  {
    name: "popcorn bundle: stakeholders the executor owns",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: [...session(), ...STAKEHOLDERS_READY],
  },
  {
    name: "popcorn bundle: stakeholders the executor owns, room",
    as: "alice",
    method: "GET",
    path: bundle,
    query: { view: "room" },
    setup: [...session(), ...STAKEHOLDERS_READY],
  },
  {
    name: "popcorn bundle: stakeholders the executor owns, turned off",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: [
      ...session({ settings: { tabs: { tensions: true, stakeholders: false } } }),
      ...STAKEHOLDERS_READY,
    ],
  },
  {
    name: "popcorn bundle: every screen",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: session({ settings: FULL }),
  },
  {
    name: "popcorn bundle: every screen, room",
    as: "erin",
    method: "GET",
    path: bundle,
    query: { view: "room" },
    setup: session({ settings: FULL }),
  },
  {
    name: "popcorn bundle: consent basis with a policy link",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: [
      ...session({ settings: { data: { enabled: true }, language: { ui: "de" } } }),
      `update project set legal_basis = 'consent', privacy_policy_url = 'https://example.test/privacy', anonymize_transcripts = true where id = '${projects.p1}'`,
    ],
  },
  {
    name: "popcorn bundle: tabs off",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: session({ settings: { tabs: { tensions: false, stakeholders: false } } }),
  },
  {
    name: "popcorn bundle: synthetic demo",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: session({ settings: { show_qr: true }, state: { demo: DEMO } }),
  },
  {
    name: "popcorn bundle: hidden items",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: session({
      settings: { presentation: { blocks: ["popcorn", "tensions"], hidden_items: ["x1", "p1"] } },
    }),
  },
  {
    name: "popcorn bundle: empty session",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: session({ state: { order: [], conversations: {}, quotes: [], analysis: null, run: 0 } }),
  },
  {
    name: "popcorn bundle: pinned results",
    as: "alice",
    method: "GET",
    path: bundle,
    setup: [
      ...session({
        settings: {
          presentation: {
            blocks: ["popcorn", "stakeholders", "tensions"],
            result_bindings: { stakeholders: pop.version, tensions: pop.oldVersion },
          },
        },
      }),
      ...versions(),
    ],
  },
  {
    name: "popcorn bundle: a saved run",
    as: "alice",
    method: "GET",
    path: bundle,
    query: { version: pop.oldVersion },
    setup: [...session(), ...versions()],
  },
  {
    name: "popcorn bundle: a saved run for the room",
    as: "alice",
    method: "GET",
    path: bundle,
    query: { version: pop.oldVersion, view: "room" },
    setup: [...session(), ...versions()],
  },
  {
    name: "popcorn bundle: a saved run that is not this session's",
    as: "alice",
    method: "GET",
    path: bundle,
    query: { version: "00000000-0000-4000-8000-000000000000" },
    setup: session(),
  },
  {
    name: "popcorn bundle: observer",
    as: "rita",
    method: "GET",
    path: bundle,
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "popcorn bundle: anonymous",
    as: "anonymous",
    method: "GET",
    path: bundle,
    setup: session(),
  },

  // ── the late-phrase beacon ──────────────────────────────────────────
  {
    name: "popcorn latency: beacon",
    as: "alice",
    method: "POST",
    path: view("/data/latency"),
    body: { ms: 4200 },
    setup: session(),
  },
  {
    name: "popcorn latency: text body",
    as: "alice",
    method: "POST",
    path: view("/data/latency"),
    headers: { "content-type": "text/plain" },
    setup: session(),
  },
  {
    name: "popcorn latency: other tenant",
    as: "bob",
    method: "POST",
    path: view("/data/latency"),
    body: { ms: 1 },
    setup: session(),
  },
]);
