import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import type { Json } from "../../../src/py";

// The rows the Python tick read when it recorded full.json (gen/tick_full.py), for the
// tests that replay it here.
export interface Call {
  name: string;
  system: string;
  user: string;
  max_tokens: number;
  fast: boolean;
  answer: Json;
}
export interface Tick {
  kind: string;
  request_id: string | null;
  status: string;
  state: Json;
  run: Json;
  version: Json | null;
  calls: Call[];
  tasks: Json[];
  loop: Json;
}
export const fixture = JSON.parse(readFileSync(join(import.meta.dir, "full.json"), "utf8")) as {
  seed: Record<string, Json[]>;
  second_chunk: Json;
  ticks: Tick[];
};

export const ids = {
  user: "d1000000-0000-4000-8000-000000000001",
  appUser: "a1000000-0000-4000-8000-000000000001",
  project: "f1000000-0000-4000-8000-000000000001",
  loop: "ca100000-0000-4000-8000-000000000001",
};
const chunkId = (n: string) => `c1200000-0000-4000-8000-00000000000${n.slice(2)}`;

export async function freshDatabase(url: string, name: string): Promise<string> {
  const a = postgres(url, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name}`);
  await a.end();
  return `${url.slice(0, url.lastIndexOf("/"))}/${name}`;
}

export async function seed(sql: postgres.Sql) {
  const raw = sql;
  const s = fixture.seed;
  await sql`insert into directus_users (id, email) values (${ids.user}, 'popcorn@example.com')`;
  await sql`insert into app_user (id, directus_user_id) values (${ids.appUser}, ${ids.user})`;
  for (const p of s.project ?? [])
    await sql`insert into project (id, name, language, directus_user_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${p.id as string}, ${p.name as string}, ${p.language as string}, ${ids.user}, true, true, false, 'workspace')`;
  for (const r of s.project_report ?? [])
    await sql`insert into project_report (id, project_id, kind, status, user_instructions, content,
      public_token, date_created)
      values (${Number(r.id)}, ${r.project_id as string}, 'popcorn', 'published', ${r.user_instructions as string},
        '', ${r.public_token as string}, ${r.date_created as string})`;
  for (const c of s.canvas_config_revision ?? [])
    await sql`insert into canvas_config_revision (id, report_id, popcorn_settings, created_at, cadence_minutes)
      values (${c.id as string}, ${c.report_id as number}, ${raw.json(c.popcorn_settings as never)},
        ${c.created_at as string}, 2)`;
  for (const l of s.agent_loop ?? [])
    await sql`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
      acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
      values (${l.id as string}, ${l.project_id as string}, ${l.report_id as number}, ${l.name as string},
        ${l.status as string}, ${l.expires_at as string}, 2, ${ids.user}, 0, ${raw.json(l.caps as never)},
        ${raw.json(l.popcorn_state as never)}, ${l.created_at as string})`;
  for (const c of s.conversation ?? [])
    await sql`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${c.id as string}, ${c.project_id as string}, ${(c.participant_name as string | null) ?? null},
        ${c.created_at as string}, ${c.duration as number})`;
  for (const ch of s.conversation_chunk ?? []) await insertChunk(sql, ch);
}

export async function insertChunk(sql: postgres.Sql, ch: Json) {
  await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
    values (${chunkId(ch.id as string)}, ${ch.conversation_id as string},
      ${(ch.transcript as string | null) ?? null}, ${ch.timestamp as string}, ${ch.created_at as string})`;
}
