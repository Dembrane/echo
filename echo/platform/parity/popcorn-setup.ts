// Setup statements the popcorn and present scenarios share: sessions the seed does not
// hold, written the way the Python service writes them, applied to both databases.
import { conversations, id, projects, users } from "./fixtures";

export const pop = {
  report: 50,
  otherReport: 51,
  config: id("f8", 1),
  loop: id("f8", 2),
  otherConfig: id("f8", 3),
  otherLoop: id("f8", 4),
  version: id("f8", 5),
  oldVersion: id("f8", 6),
  analysisScope: id("f8", 7),
  token: "parityPublicToken_0000000001",
  otherToken: "parityPublicToken_0000000002",
} as const;

const q = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'`;

/** The settings a session keeps, as normalize_settings leaves them. */
export function settings(over: Record<string, unknown> = {}) {
  return {
    title: "City session",
    client: "City of Parity",
    tabs: { tensions: true, stakeholders: true },
    public: false,
    show_qr: false,
    show_branding: true,
    voice: { presets: ["gentle"], note: "Keep it kind." },
    recipe_settings: { voice: { presets: ["gentle"], note: "Keep it kind." } },
    intro: { enabled: true, title: "Welcome", subtitle: "What we heard" },
    disclosure: { enabled: false, text: "", invitation_title: "", invitation_text: "" },
    notice: { enabled: true, text: "Recording in progress" },
    data: { enabled: false },
    language: { ui: "auto", translate_to: "", also: [] },
    public_labels: "neutral",
    ...over,
  };
}

const c1 = conversations.c1;
const c2 = conversations.c2;

/** A session mid-way: one conversation read and validated, one still being read, analysis done. */
export function state(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    run: 3,
    order: [c1, c2],
    conversations: {
      [c1]: {
        id: c1,
        label: "Resident 1",
        short: "Resident 1",
        created_at: "2026-09-01T09:20:00.000Z",
        duration: 312.5,
        revision: 2,
        done: true,
        fingerprint: "abc123",
        validated_fingerprint: "abc123",
        chars: 180000,
        clipped: 30000,
        review: { dropped: [{ phrase: "hidden" }, { phrase: "also hidden" }] },
        items: [
          {
            id: "p1",
            phrase: "charging points near the flats",
            verbatim: true,
            quoteId: "q1",
            kind: "need",
            qualifiers: ["urgent"],
            review: { note: "never leaves" },
          },
          {
            id: "p2",
            phrase: "buses stop at eleven",
            question: true,
            source: { text: "Buses stop running at eleven", score: 0.8 },
          },
          { id: "p3", phrase: "" },
        ],
      },
      [c2]: {
        id: c2,
        label: "Resident 2",
        short: "R2",
        created_at: "2026-09-01T09:40:00.000Z",
        duration: null,
        revision: 1,
        done: false,
        items: [],
      },
    },
    quotes: [
      {
        id: "q1",
        transcript: c1,
        text: "We need more charging points near the flats",
        context: "Early on, when Maria introduced herself",
      },
      { id: "q2", transcript: c1, text: "the grid connection took our street a year" },
    ],
    analysis: {
      updated_at: "2026-09-01T10:00:00+00:00",
      fingerprints: { tensions: "f", stakeholders: "f" },
      tensions: {
        tensions: [
          {
            id: "x1",
            poleA: "Drive",
            poleB: "Bus",
            knot: "Late buses",
            toResolve: "Night service",
            quoteIds: ["q2"],
          },
        ],
      },
      stakeholders: {
        stakeholders: [
          {
            id: "s1",
            name: "Residents",
            role: "live here",
            stake: "getting around",
            quoteIds: ["q1"],
            evidence: { rung: "voiced" },
            weight: { stake: 0.9, mentions: 0.5 },
          },
        ],
        relations: [],
      },
    },
    translations: {
      nl: {},
    },
    ...over,
  };
}

/** A synthetic demo's marking, as the demo seed writes it into the state. */
export const DEMO = {
  synthetic: true,
  public_sources_only: true,
  language: "nl",
  portal_url: "https://portal.example.test/nl-NL/x/start?utm_source=popcorn_demo",
  portal_urls: { nl: "https://portal.example.test/nl-NL/x/start?utm_source=popcorn_demo" },
  disclosure: { text: "Alles is verzonnen.", invitation_title: "", invitation_text: "" },
  notice: { text: "Synthetische demo" },
};

export interface SessionOptions {
  readonly project?: string;
  readonly reportId?: number;
  readonly config?: string;
  readonly loop?: string | null;
  readonly token?: string | null;
  readonly settings?: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
  readonly status?: string;
  readonly kind?: string;
  readonly owner?: string;
}

/** A popcorn session: its report, settings revision and loop in manual mode. */
export function session(o: SessionOptions = {}): string[] {
  const project = o.project ?? projects.p1;
  const reportId = o.reportId ?? pop.report;
  const owner = o.owner ?? users.alice.directus;
  const token = o.token === undefined ? pop.token : o.token;
  const out = [
    `insert into project_report (id, project_id, kind, status, user_instructions, content, public_token, user_created, date_created)
      values (${reportId}, '${project}', '${o.kind ?? "popcorn"}', 'published', 'City session', '',
        ${token === null ? "null" : `'${token}'`}, '${owner}', '2026-09-01T09:00:00Z')`,
    `insert into canvas_config_revision (id, report_id, brief, gather_spec, popcorn_settings, cadence_minutes, created_by, note, created_at)
      values ('${o.config ?? pop.config}', ${reportId}, '', '{"full_history":true}', ${q(settings(o.settings))}, 2,
        '${owner}', 'initial', '2026-09-01T09:00:00Z')`,
  ];
  if (o.loop !== null)
    out.push(`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes, acting_directus_user_id, failure_count, caps, popcorn_state, created_at, updated_at)
      values ('${o.loop ?? pop.loop}', '${project}', ${reportId}, 'City session', '${o.status ?? "paused"}',
        '2026-09-01T09:00:00Z', 2, '${owner}', 0, '{"kind":"popcorn"}', ${q(state(o.state))},
        '2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z')`);
  return out;
}

/** The latest run of the session's loop and a pending scheduled read. */
export const RUNS = [
  `insert into agent_loop_run (id, loop_id, status, detail, started_at, finished_at)
    values ('${id("f8", 10)}', '${pop.loop}', 'ok', 'run 3: 1 of 2 conversations re-read', '2026-09-01T09:29:00Z', '2026-09-01T09:30:00Z')`,
  `insert into agent_loop_run (id, loop_id, status, detail, started_at, finished_at)
    values ('${id("f8", 11)}', '${pop.loop}', 'error', 'translation failed: boom', '2026-09-01T09:31:00Z', '2026-09-01T09:31:30Z')`,
  `insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
    values ('${id("f8", 12)}', 'popcorn_tick', '{"loop_id": "${pop.loop}", "tick_kind": "scheduled"}', '2099-01-01T10:00:00Z', 'scheduled', 0, now(), now())`,
  `insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
    values ('${id("f8", 13)}', 'popcorn_tick', '{"loop_id": "${pop.loop}", "tick_kind": "manual"}', '2098-01-01T10:00:00Z', 'scheduled', 0, now(), now())`,
];

/** Two saved runs: one saved as the host's bundle before 6 September, one as the room's. */
export function versions(): string[] {
  const hostFiles = {
    files: {
      "session.json": {
        title: "City session",
        host: { tabs: { tensions: true } },
        transcripts: [{ id: c1, label: "Resident 1", short: "Resident 1" }, "junk"],
      },
      [`popcorn/${c1}.json`]: {
        transcript: c1,
        coverage: { chars: 1, clipped: 1 },
        items: [{ id: "p2", phrase: "buses", source: { text: "x", url: "u" } }],
      },
      "quotes.json": { quotes: [{ id: "q1", text: "t", url: "https://x" }] },
      "tensions.json": { tensions: [{ id: "x1", quoteIds: ["q1"] }] },
    },
  };
  return [
    `insert into canvas_generation (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
      values ('${pop.oldVersion}', ${pop.report}, '${pop.config}', ${q(hostFiles)}, 'ok', 'manual', 'run 2', '2026-09-01T09:10:00Z')`,
    `insert into canvas_generation (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
      values ('${pop.version}', ${pop.report}, '${pop.config}', '{"files": {"stakeholders.json": {"stakeholders": [{"id": "s1", "quoteIds": ["q1"]}], "relations": []}, "quotes.json": {"quotes": [{"id": "q1", "text": "pinned"}]}}}', 'ok', 'rerun', 'run 3', '2026-09-01T09:20:00Z')`,
    `insert into canvas_generation (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
      values ('${id("f8", 14)}', ${pop.report}, '${pop.config}', 'not json', 'error', 'manual', 'failed', '2026-09-01T09:25:00Z')`,
  ];
}

export const P1_CANVAS = `update project set is_canvas_enabled = true where id = '${projects.p1}'`;
