// Scratch databases for the run tests: the full schema from the migrations plus the few
// rows a turn reads (a user, a project, a chat, a run with one user turn).
import { migrate } from "@echo/db";
import { installQueueSchema } from "@echo/queue";
import postgres from "postgres";

export const ids = {
  user: "d0000000-0000-4000-8000-00000000e001",
  appUser: "a0000000-0000-4000-8000-00000000e001",
  project: "f0000000-0000-4000-8000-00000000e001",
  chat: "c3000000-0000-4000-8000-00000000e001",
  run: "e0000000-0000-4000-8000-00000000e001",
};

export function scratchUrl(admin: string, name: string) {
  return `${admin.slice(0, admin.lastIndexOf("/"))}/${name}`;
}

export async function prepareDb(admin: string, name: string, opts: { queue?: boolean } = {}) {
  const a = postgres(admin, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name}`);
  await a.end();
  const url = scratchUrl(admin, name);
  await migrate(url);
  if (opts.queue) await installQueueSchema(url);
  return url;
}

/** One user turn queued on a fresh run, as POST /api/agentic/runs leaves it. */
export async function seedRun(url: string, message = "What did people say about parking?") {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`insert into directus_users (id, email, status, provider) values (${ids.user}, 'e2e@example.com', 'active', 'default') on conflict do nothing`;
  await sql`insert into app_user (id, directus_user_id, email) values (${ids.appUser}, ${ids.user}, 'E2E@Example.com') on conflict do nothing`;
  await sql`insert into project (id, name, directus_user_id, is_conversation_allowed) values (${ids.project}, 'Parking', ${ids.user}, true) on conflict do nothing`;
  await sql`insert into project_chat (id, project_id, chat_mode, date_created) values (${ids.chat}, ${ids.project}, 'agentic', now()) on conflict do nothing`;
  await sql`delete from project_agentic_run where id = ${ids.run}`;
  await sql`insert into project_agentic_run (id, project_id, project_chat_id, directus_user_id, status, last_event_seq, created_at)
            values (${ids.run}, ${ids.project}, ${ids.chat}, ${ids.user}, 'queued', 1, now())`;
  await sql`insert into project_agentic_run_event (project_agentic_run_id, seq, event_type, payload, timestamp)
            values (${ids.run}, 1, 'user.message', ${sql.json({ content: message, agent_prompt_content: `User Message: ${message}` })}, now())`;
  await sql.end();
}
