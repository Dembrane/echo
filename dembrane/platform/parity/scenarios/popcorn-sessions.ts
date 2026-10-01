import { projects } from "../fixtures";
import { DEMO, pop, RUNS, session } from "../popcorn-setup";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, legacy } = projects;
const base = "/api/v2/bff/popcorn";
const one = (id: number | string, tail = "") => `${base}/${id}${tail}`;
// A new session mints a random share token on both sides.
const TOKEN = ["public_token"];

export default scenarios([
  // ── the project's session ───────────────────────────────────────────
  {
    name: "popcorn get: anonymous",
    as: "anonymous",
    method: "GET",
    path: base,
    query: { project_id: p1 },
  },
  {
    name: "popcorn get: none yet, readiness",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: p1 },
  },
  {
    name: "popcorn get: the session",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: p1 },
    setup: [...session(), ...RUNS],
  },
  {
    name: "popcorn get: workspace member",
    as: "admin",
    method: "GET",
    path: base,
    query: { project_id: p1 },
    setup: session(),
  },
  {
    name: "popcorn get: observer",
    as: "rita",
    method: "GET",
    path: base,
    query: { project_id: p2 },
    setup: [P2_OPEN, ...session({ project: p2 })],
  },
  {
    name: "popcorn get: other tenant",
    as: "bob",
    method: "GET",
    path: base,
    query: { project_id: p1 },
  },
  {
    name: "popcorn get: not onboarded",
    as: "dave",
    method: "GET",
    path: base,
    query: { project_id: legacy },
  },
  { name: "popcorn get: missing project_id", as: "alice", method: "GET", path: base },
  {
    name: "popcorn get: not a uuid",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: "nope" },
  },
  {
    name: "popcorn get: deleted project",
    as: "alice",
    method: "GET",
    path: base,
    query: { project_id: p1 },
    setup: [`update project set deleted_at = now() where id = '${p1}'`],
  },

  // ── create ──────────────────────────────────────────────────────────
  {
    name: "popcorn create: owner",
    as: "alice",
    method: "POST",
    path: base,
    body: { project_id: p1, title: "  Town hall  ", client: " City " },
    ignoreFields: TOKEN,
  },
  {
    name: "popcorn create: with a voice",
    as: "erin",
    method: "POST",
    path: base,
    body: {
      project_id: p1,
      title: "Town hall",
      voice: { presets: ["plain", "nope"], note: "  short   and plain " },
    },
    ignoreFields: TOKEN,
  },
  {
    name: "popcorn create: one per project",
    as: "alice",
    method: "POST",
    path: base,
    body: {
      project_id: p1,
      title: "Again",
      cadence_minutes: 5,
      expires_at: "2026-09-01T10:00:00Z",
    },
    setup: session(),
  },
  {
    name: "popcorn create: observer",
    as: "rita",
    method: "POST",
    path: base,
    body: { project_id: p2, title: "No" },
    setup: [P2_OPEN],
  },
  {
    name: "popcorn create: other tenant",
    as: "bob",
    method: "POST",
    path: base,
    body: { project_id: p1, title: "No" },
  },
  {
    name: "popcorn create: anonymous",
    as: "anonymous",
    method: "POST",
    path: base,
    body: { project_id: p1, title: "No" },
  },
  {
    name: "popcorn create: empty title",
    as: "alice",
    method: "POST",
    path: base,
    body: { project_id: p1, title: "" },
  },
  { name: "popcorn create: no body", as: "alice", method: "POST", path: base },
  {
    name: "popcorn create: bad types",
    as: "alice",
    method: "POST",
    path: base,
    body: {
      project_id: 5,
      title: "x".repeat(161),
      client: 3,
      voice: { note: 5 },
      cadence_minutes: "x",
      expires_at: "nope",
    },
  },
  {
    name: "popcorn create: bad date",
    as: "alice",
    method: "POST",
    path: base,
    body: { project_id: p1, title: "t", expires_at: "2026-13-01" },
  },

  // ── one session ─────────────────────────────────────────────────────
  {
    name: "popcorn detail: owner",
    as: "alice",
    method: "GET",
    path: one(pop.report),
    setup: [...session(), ...RUNS],
  },
  {
    name: "popcorn detail: other tenant",
    as: "bob",
    method: "GET",
    path: one(pop.report),
    setup: session(),
  },
  {
    name: "popcorn detail: not onboarded",
    as: "dave",
    method: "GET",
    path: one(pop.report),
    setup: session(),
  },
  { name: "popcorn detail: missing", as: "alice", method: "GET", path: one(99) },
  {
    name: "popcorn detail: not a number",
    as: "alice",
    method: "GET",
    path: one("abc"),
    differs:
      "a malformed report id answers 404 Report not found, not the 500 Directus's refusal became",
  },
  { name: "popcorn detail: a plain report", as: "alice", method: "GET", path: one(1) },
  {
    name: "popcorn detail: deleted",
    as: "alice",
    method: "GET",
    path: one(pop.report),
    setup: [...session(), `update project_report set deleted_at = now() where id = ${pop.report}`],
  },
  {
    name: "popcorn detail: synthetic demo",
    as: "alice",
    method: "GET",
    path: one(pop.report),
    setup: session({ state: { demo: DEMO } }),
  },
  {
    name: "popcorn detail: no loop",
    as: "alice",
    method: "GET",
    path: one(pop.report),
    setup: session({ loop: null }),
  },
  {
    name: "popcorn detail: legacy settings shapes",
    as: "alice",
    method: "GET",
    path: one(pop.report),
    setup: session({
      settings: {
        title: "   ",
        voice: { preset: "plain", note: "x" },
        recipe_settings: {},
        tabs: { tensions: 0 },
        language: { ui: "xx", translate_to: "nl", also: ["nl", "de", "de", "fr", "es", "zz"] },
        presentation: {
          blocks: ["map", "bogus"],
          opening: "map",
          hidden_items: ["a", "a", 5],
          result_bindings: { map: "m", bad: "x", tensions: 5 },
        },
        intro: { enabled: "yes", title: 5 },
      },
    }),
  },
]);
