// Setup statements the assistant data and memory scenarios share: rows the seed does not
// hold, applied identically to both databases before the request.
import { chats, conversations, id, projects, users, workspaces } from "./fixtures";

export const agenticExtra = {
  memUserAlice: id("f8", 1),
  memUserBob: id("f8", 2),
  memProjectP1: id("f8", 3),
  memWorkspaceA: id("f8", 4),
  memWorkspaceResearch: id("f8", 5),
  memKeyed: id("f8", 6),
  memBroken: id("f8", 7),
  insightP1: id("f9", 1),
  insightP1Archived: id("f9", 2),
  insightP3: id("f9", 3),
  chatErinPrivate: id("c3", 5),
  chatP3: id("c3", 6),
  chatP2: id("c3", 7),
  chatDeleted: id("c3", 8),
  goal: id("fa", 1),
  recentChunk: id("c2", 9),
} as const;
const x = agenticExtra;

/** Memory in every scope, with distinct update times so the newest-first order is fixed. */
export const MEMORIES = `insert into agent_memory
  (id, scope, memory_key, content, source, directus_user_id, workspace_id, project_id, created_at, updated_at) values
  ('${x.memUserAlice}', 'user', null, 'Alice likes short answers', 'agent', '${users.alice.directus}', null, null, '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'),
  ('${x.memUserBob}', 'user', null, 'Bob writes in Dutch', 'agent', '${users.bob.directus}', null, null, '2026-09-01T10:01:00Z', '2026-09-01T10:01:00Z'),
  ('${x.memProjectP1}', 'project', null, 'Interviews run in pairs', 'agent', null, '${workspaces.aDefault}', '${projects.p1}', '2026-09-01T10:02:00Z', '2026-09-01T10:02:00Z'),
  ('${x.memWorkspaceA}', 'workspace', null, 'Reports go out on Fridays', 'agent', null, '${workspaces.aDefault}', null, '2026-09-01T10:03:00Z', '2026-09-01T10:03:00Z'),
  ('${x.memWorkspaceResearch}', 'workspace', null, 'Research uses consent forms', 'agent', null, '${workspaces.aResearch}', null, '2026-09-01T10:04:00Z', '2026-09-01T10:04:00Z'),
  ('${x.memKeyed}', 'project', 'cadence', 'Weekly check-ins', 'agent', null, '${workspaces.aDefault}', '${projects.p1}', '2026-09-01T10:05:00Z', '2026-09-01T10:05:00Z'),
  ('${x.memBroken}', 'mystery', null, 'No owner', 'agent', null, null, null, '2026-09-01T10:06:00Z', '2026-09-01T10:06:00Z')`;

export const INSIGHTS = `insert into agent_insight
  (id, source, workspace_id, project_id, chat_id, message_id, kind, content, suggested_capability, status, created_at) values
  ('${x.insightP1}', 'assistant', '${workspaces.aDefault}', '${projects.p1}', '${chats.p1}', 'm-1', 'wish', 'Wants a map view', 'maps', 'new', '2026-09-01T11:00:00Z'),
  ('${x.insightP1Archived}', 'assistant', '${workspaces.aDefault}', '${projects.p1}', null, null, 'friction', 'Export is slow', null, 'archived', '2026-09-01T11:01:00Z'),
  ('${x.insightP3}', 'assistant', '${workspaces.bDefault}', '${projects.p3}', null, null, 'praise', 'Likes the portal', null, 'new', '2026-09-01T11:02:00Z')`;

/** Chats beyond the seed's one: a colleague's private chat on p1, and chats on p2, p3. */
export const MORE_CHATS = [
  `insert into project_chat (id, project_id, name, chat_mode, is_private, user_created, date_created, date_updated)
    values ('${x.chatErinPrivate}', '${projects.p1}', 'Erin private', 'agentic', true, '${users.erin.directus}', '2026-09-02T09:00:00Z', '2026-09-02T09:00:00Z')`,
  `insert into project_chat (id, project_id, name, chat_mode, user_created, date_created, date_updated)
    values ('${x.chatP3}', '${projects.p3}', 'Org B chat', 'agentic', '${users.bob.directus}', '2026-09-02T10:00:00Z', '2026-09-02T10:00:00Z')`,
  `insert into project_chat (id, project_id, name, chat_mode, user_created, date_created, date_updated)
    values ('${x.chatP2}', '${projects.p2}', 'Research chat', 'agentic', '${users.erin.directus}', '2026-09-02T11:00:00Z', '2026-09-02T11:00:00Z')`,
  `insert into project_chat (id, project_id, name, chat_mode, user_created, deleted_at)
    values ('${x.chatDeleted}', '${projects.p1}', 'Gone', 'agentic', '${users.alice.directus}', '2026-09-03T09:00:00Z')`,
  `insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
    values ('${id("c4", 5)}', '${x.chatErinPrivate}', 'user', 'secret plan', '2026-09-02T09:01:00Z')`,
];

/** A second, soft-deleted and a duplicate attachment on the seed chat, for the focus list. */
export const FOCUS_LINKS = [
  `insert into project_chat_conversation (project_chat_id, conversation_id) values ('${chats.p1}', '${conversations.c2}')`,
  `insert into project_chat_conversation (project_chat_id, conversation_id) values ('${chats.p1}', '${conversations.c1}')`,
  `update conversation set deleted_at = '2026-09-03T00:00:00Z' where id = '${conversations.c2}'`,
];

export const GOAL = `insert into project_goal_revision (id, project_id, content, set_by, created_at)
  values ('${x.goal}', '${projects.p1}', 'Map the charging gaps', 'host', '2026-09-01T12:00:00Z')`;

/** A chunk that landed seconds ago, with a transcription error, so the monitor has one live row. */
export const RECENT_CHUNK = `insert into conversation_chunk (id, conversation_id, timestamp, transcript, error, source, created_at, updated_at)
  values ('${x.recentChunk}', '${conversations.c2}', now() - interval '5 seconds', null, 'Transcription failed: timeout', 'PORTAL_AUDIO', now(), now())`;

/** Org B over its free hour: its one conversation stamped over the cap. */
export const P3_OVER_CAP = [
  `update conversation set is_over_cap = true, duration = 4000 where id = '${conversations.c3}'`,
];
