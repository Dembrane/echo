import type postgres from "postgres";

// Fixed rows for the canvas integration tests: a legacy project its acting user owns, one
// canvas report with its config and active loop, and one conversation with fresh text.
export const ids = {
  user: "d1000000-0000-4000-8000-000000000001",
  appUser: "a1000000-0000-4000-8000-000000000001",
  project: "f1000000-0000-4000-8000-000000000001",
  config: "ca100000-0000-4000-8000-000000000002",
  loop: "ca100000-0000-4000-8000-000000000001",
  conversation: "c1100000-0000-4000-8000-000000000001",
  chunk: "c1200000-0000-4000-8000-000000000001",
  report: "7",
} as const;

export const TRANSCRIPT =
  "We need more charging points near the flats. The waiting list is months long.";

export const EXTRACTION = JSON.stringify({
  quotes: [
    {
      who: "Resident",
      quote: "We need more charging points near the flats.",
      conversation_id: ids.conversation,
      chunk_id: ids.chunk,
    },
  ],
  concepts: [{ phrase: "charging points", supporting_quote_indices: [0] }],
  crux: { question: "Where should the next chargers go?" },
  story_slides: [
    { eyebrow: null, heading: "Charging", lede: "Chargers are scarce", quote_indices: [0] },
  ],
});

export const GUIDE = JSON.stringify({
  where_the_room_is: "The room wants chargers.",
  what_to_ask_next: ["Which street first?"],
  under_heard: [],
});

export async function seed(sql: postgres.Sql, opts: { actingUser?: string } = {}) {
  await sql.unsafe(`
    insert into directus_users (id, email) values ('${ids.user}', 'canvas@example.com') on conflict do nothing;
    insert into app_user (id, directus_user_id) values ('${ids.appUser}', '${ids.user}') on conflict do nothing;
    insert into project (id, name, language, directus_user_id, is_conversation_allowed, is_canvas_enabled, visibility)
      values ('${ids.project}', 'City', 'en', '${ids.user}', true, true, 'workspace') on conflict do nothing;
    insert into project_report (id, project_id, kind, status, user_instructions, content, date_created)
      values (${ids.report}, '${ids.project}', 'canvas', 'published', 'Mood', '', now()) on conflict do nothing;
    insert into canvas_config_revision (id, report_id, brief, gather_spec, cadence_minutes, note, created_at)
      values ('${ids.config}', ${ids.report}, 'Show the mood', '{"window_minutes": 60}', 5, 'initial', now()) on conflict do nothing;
    insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes, acting_directus_user_id, failure_count, caps, created_at)
      values ('${ids.loop}', '${ids.project}', ${ids.report}, 'Mood', 'active', now() + interval '1 day', 5, '${opts.actingUser ?? ids.user}', 0, '{}', now()) on conflict do nothing;
    insert into conversation (id, project_id, participant_name, created_at)
      values ('${ids.conversation}', '${ids.project}', 'Resident', now()) on conflict do nothing;
    insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values ('${ids.chunk}', '${ids.conversation}', '${TRANSCRIPT}', now(), now()) on conflict do nothing;
  `);
}

export async function freshDatabase(admin: string, name: string): Promise<string> {
  const { default: postgres } = await import("postgres");
  const a = postgres(admin, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name}`);
  await a.end();
  return `${admin.slice(0, admin.lastIndexOf("/"))}/${name}`;
}
