import { CANVAS_ON_LEGACY, CANVAS_ON_P2, CANVASES, canvas } from "../chat-canvas-setup";
import { chats, projects } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, legacy } = projects;
const base = (p: string) => `/api/agentic/projects/${p}`;
const c = (id: string, p = p1) => `${base(p)}/canvases/${id}`;

// The canvas ledger columns (agent_loop.canvas_*, canvas_config_revision.tabs) were never
// applied to main's schema. The Python service asks Directus for them, gets nothing and
// reads "no loop" and "no config". Migration 0007 adds them to the platform schema, so the
// port reads the seeded loop and config: the scenarios that reach them differ on purpose.
const LEDGERS =
  "ledger columns absent on the old side (Directus sees no loop or config); migration 0007 adds them and the port reads the seeded loop and config";

export default scenarios([
  // ── the canvas beta gate, which answers before the session ────────
  { name: "canvas list: canvas off", as: "alice", method: "GET", path: `${base(p1)}/canvases` },
  {
    name: "canvas list: anonymous, canvas off",
    as: "anonymous",
    method: "GET",
    path: `${base(p1)}/canvases`,
  },
  {
    name: "canvas list: anonymous, canvas on",
    as: "anonymous",
    method: "GET",
    path: `${base(p1)}/canvases`,
    setup: CANVASES,
  },
  {
    name: "canvas list: unknown project",
    as: "alice",
    method: "GET",
    path: `${base("f0000000-0000-4000-8000-000000000099")}/canvases`,
    setup: CANVASES,
  },

  // ── list ──────────────────────────────────────────────────────────
  {
    name: "canvas list: owner",
    as: "alice",
    method: "GET",
    path: `${base(p1)}/canvases`,
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas list: staff",
    as: "admin",
    method: "GET",
    path: `${base(p1)}/canvases`,
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas list: other tenant",
    as: "bob",
    method: "GET",
    path: `${base(p1)}/canvases`,
    setup: CANVASES,
  },
  {
    name: "canvas list: observer refused",
    as: "rita",
    method: "GET",
    path: `${base(p2)}/canvases`,
    setup: [P2_OPEN, CANVAS_ON_P2],
  },
  {
    name: "canvas list: external on an open project",
    as: "bob",
    method: "GET",
    path: `${base(p2)}/canvases`,
    setup: [P2_OPEN, CANVAS_ON_P2],
  },
  {
    name: "canvas list: not onboarded",
    as: "dave",
    method: "GET",
    path: `${base(legacy)}/canvases`,
    setup: [CANVAS_ON_LEGACY],
  },

  // ── canvas activity ───────────────────────────────────────────────
  {
    name: "canvas activity: chat of the project",
    as: "alice",
    method: "GET",
    path: `${base(p1)}/chats/${chats.p1}/canvas-activity`,
    setup: CANVASES,
    differs:
      "a loop without a name takes its canvas's instructions; Python read a project_report.name column that does not exist and fell back to Canvas",
  },
  {
    name: "canvas activity: one run each",
    as: "alice",
    method: "GET",
    path: `${base(p1)}/chats/${chats.p1}/canvas-activity`,
    query: { limit: "1" },
    setup: [...CANVASES, `update agent_loop set name = 'Energy loop' where report_id = 903`],
  },
  {
    name: "canvas activity: unknown chat",
    as: "alice",
    method: "GET",
    path: `${base(p1)}/chats/c3000000-0000-4000-8000-000000000099/canvas-activity`,
    setup: CANVASES,
  },
  {
    name: "canvas activity: colleague's private chat",
    as: "erin",
    method: "GET",
    path: `${base(p1)}/chats/${chats.p1}/canvas-activity`,
    setup: [...CANVASES, `update project_chat set is_private = true where id = '${chats.p1}'`],
  },
  {
    name: "canvas activity: limit zero",
    as: "alice",
    method: "GET",
    path: `${base(p1)}/chats/${chats.p1}/canvas-activity`,
    query: { limit: "0" },
    setup: CANVASES,
  },

  // ── one canvas and its history ────────────────────────────────────
  {
    name: "canvas get: owner",
    as: "alice",
    method: "GET",
    path: c(canvas.p1),
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas get: a report is not a canvas",
    as: "alice",
    method: "GET",
    path: c(canvas.report),
    setup: CANVASES,
  },
  {
    name: "canvas get: deleted canvas",
    as: "alice",
    method: "GET",
    path: c(canvas.deleted),
    setup: CANVASES,
  },
  {
    name: "canvas get: another project's canvas",
    as: "admin",
    method: "GET",
    path: c(canvas.p3),
    setup: CANVASES,
  },
  {
    name: "canvas history: owner",
    as: "alice",
    method: "GET",
    path: `${c(canvas.p1)}/history`,
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas history: two entries",
    as: "alice",
    method: "GET",
    path: `${c(canvas.p1)}/history`,
    query: { limit: "2" },
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas history: limit zero",
    as: "alice",
    method: "GET",
    path: `${c(canvas.p1)}/history`,
    query: { limit: "0" },
    setup: CANVASES,
  },

  // ── edits ─────────────────────────────────────────────────────────
  {
    name: "canvas edit: owner",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/edit`,
    body: { instruction: "Bigger headings", content_html: "<h1>Hi</h1>", chat_id: chats.p1 },
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas edit: blank instruction",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/edit`,
    body: { instruction: "   ", content_html: "<p>x</p>" },
    setup: CANVASES,
  },
  {
    name: "canvas edit: missing fields",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/edit`,
    body: { instruction: "" },
    setup: CANVASES,
  },
  {
    name: "canvas edit: observer refused",
    as: "rita",
    method: "POST",
    path: `${c(canvas.p1, p2)}/edit`,
    body: { instruction: "x", content_html: "<p>x</p>" },
    setup: [P2_OPEN, CANVAS_ON_P2],
  },

  // ── host items ────────────────────────────────────────────────────
  {
    name: "canvas host item: add",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/host-items`,
    body: { text: "Ask about night buses", target_tab: "story", person: "Ana" },
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas host item: blank text",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/host-items`,
    body: { text: "  " },
    setup: CANVASES,
  },
  {
    name: "canvas host item: too long",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/host-items`,
    body: { text: "x".repeat(2001), person: "y".repeat(161) },
    setup: CANVASES,
  },
  {
    name: "canvas host item: remove",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/host-items/remove`,
    body: { item: "night buses" },
    setup: CANVASES,
    differs: `${LEDGERS}; a refused removal is 400 like an add, Python let the ValueError escape as a 500`,
  },
  {
    name: "canvas host item: remove, missing item",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/host-items/remove`,
    body: {},
    setup: CANVASES,
  },

  // ── the loop ──────────────────────────────────────────────────────
  {
    name: "canvas loop: pause",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/loop/pause`,
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas loop: resume an ended loop",
    as: "alice",
    method: "POST",
    path: `${c(canvas.unnamed)}/loop/resume`,
    setup: CANVASES,
    differs: LEDGERS,
  },
  {
    name: "canvas loop: unknown action",
    as: "alice",
    method: "POST",
    path: `${c(canvas.p1)}/loop/explode`,
    setup: CANVASES,
  },
  {
    name: "canvas loop: other tenant",
    as: "bob",
    method: "POST",
    path: `${c(canvas.p1)}/loop/stop`,
    setup: CANVASES,
  },
]);
