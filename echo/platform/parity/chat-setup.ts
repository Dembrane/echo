// Seed SQL for the chat scenarios: chats the parity seed does not have. Plain SQL, so both
// stacks start from identical rows (Directus would stamp its own service account).
import { chats, conversations, id, projects, users } from "./fixtures";

export const chat = {
  noMode: id("c5", 1),
  private: id("c5", 2),
  agentic: id("c5", 3),
  p2: id("c5", 4),
  p3: id("c5", 5),
} as const;

const insertChat = (
  cid: string,
  project: string,
  mode: string | null,
  owner: string,
  isPrivate = false,
) =>
  `insert into project_chat (id, project_id, name, chat_mode, user_created, is_private, date_created)
   values ('${cid}', '${project}', null, ${mode ? `'${mode}'` : "null"}, '${owner}', ${isPrivate}, now())`;

export const NO_MODE_CHAT = insertChat(chat.noMode, projects.p1, null, users.alice.directus);
export const PRIVATE_CHAT = insertChat(
  chat.private,
  projects.p1,
  "deep_dive",
  users.alice.directus,
  true,
);
export const AGENTIC_CHAT = insertChat(chat.agentic, projects.p1, "agentic", users.alice.directus);
export const P2_CHAT = insertChat(chat.p2, projects.p2, "deep_dive", users.erin.directus);
export const P3_CHAT = insertChat(chat.p3, projects.p3, "deep_dive", users.bob.directus);

const msg = (n: number, cid: string, from: string, text: string, tokens: number | null = null) =>
  `insert into project_chat_message (id, project_chat_id, message_from, text, tokens_count, date_created)
   values ('${id("c6", n)}', '${cid}', '${from}', '${text}', ${tokens ?? "null"}, now() + interval '${n} seconds')`;

/** Three user turns on bob's free-tier chat: the fourth is refused. */
export const P3_THREE_TURNS = [
  P3_CHAT,
  msg(1, chat.p3, "user", "one"),
  msg(2, chat.p3, "user", "two"),
  msg(3, chat.p3, "user", "three"),
];
/** One user message on bob's chat: the free tier's single chat is spent. */
export const P3_ONE_TURN = [P3_CHAT, msg(4, chat.p3, "user", "hello")];

/** A message on the seed chat with no stored token count yet. */
export const UNCOUNTED_MESSAGE = msg(5, chats.p1, "user", "And what about the grid?");

/** A message that used conversation 1, which locks it in the seed chat. */
export const C1_LOCKED = [
  msg(6, chats.p1, "dembrane", "You added 1 conversation as context to the chat."),
  `insert into project_chat_message_conversation (project_chat_message_id, conversation_id)
   values ('${id("c6", 6)}', '${conversations.c1}')`,
];

export const SEED_MESSAGE = id("c4", 1);
