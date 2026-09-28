import { chat, P2_CHAT, P3_ONE_TURN, PRIVATE_CHAT, SEED_MESSAGE } from "../chat-setup";
import { chats, projects } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, p3 } = projects;
const CH = "/api/v2/bff/chats";
const MSG = "/api/v2/bff/chat-messages";
const MISSING = "c5000000-0000-4000-8000-0000000000ff";
const CREATOR = "creator: user_created is the caller, not the Directus service account";
const UPDATER = "updater: user_updated is the caller, not the Directus service account";
const M10 = "M-10: a private chat is its creator's; a colleague gets 404";

export default scenarios([
  // ── POST /v2/bff/chats ────────────────────────────────────────────
  {
    name: "bff chat create: owner",
    as: "alice",
    method: "POST",
    path: CH,
    body: { project_id: p1 },
    differs: CREATOR,
  },
  {
    name: "bff chat create: named",
    as: "alice",
    method: "POST",
    path: CH,
    body: { project_id: p1, name: "Grid questions" },
    differs: CREATOR,
  },
  {
    name: "bff chat create: free tier first chat",
    as: "bob",
    method: "POST",
    path: CH,
    body: { project_id: p3 },
    differs: CREATOR,
  },
  {
    name: "bff chat create: free tier second chat",
    as: "bob",
    method: "POST",
    path: CH,
    body: { project_id: p3 },
    setup: P3_ONE_TURN,
  },
  {
    name: "bff chat create: observer refused",
    as: "rita",
    method: "POST",
    path: CH,
    body: { project_id: p2 },
    setup: P2_OPEN,
  },
  {
    name: "bff chat create: other tenant",
    as: "bob",
    method: "POST",
    path: CH,
    body: { project_id: p1 },
  },
  {
    name: "bff chat create: not onboarded",
    as: "dave",
    method: "POST",
    path: CH,
    body: { project_id: p1 },
  },
  {
    name: "bff chat create: missing project",
    as: "alice",
    method: "POST",
    path: CH,
    body: { project_id: MISSING },
  },
  { name: "bff chat create: no project_id", as: "alice", method: "POST", path: CH, body: {} },
  {
    name: "bff chat create: anonymous",
    as: "anonymous",
    method: "POST",
    path: CH,
    body: { project_id: p1 },
  },

  // ── GET /v2/bff/chats ─────────────────────────────────────────────
  { name: "bff chat list: owner", as: "alice", method: "GET", path: CH, query: { project_id: p1 } },
  {
    name: "bff chat list: with messages only",
    as: "alice",
    method: "GET",
    path: CH,
    query: { project_id: p1, has_messages: "true" },
    setup: PRIVATE_CHAT,
  },
  {
    name: "bff chat list: search",
    as: "alice",
    method: "GET",
    path: CH,
    query: { project_id: p1, q: "RESIDENTS" },
  },
  {
    name: "bff chat list: page",
    as: "alice",
    method: "GET",
    path: CH,
    query: { project_id: p1, limit: "1", offset: "1" },
    setup: PRIVATE_CHAT,
  },
  {
    name: "bff chat list: own private chat shows",
    as: "alice",
    method: "GET",
    path: CH,
    query: { project_id: p1 },
    setup: PRIVATE_CHAT,
  },
  {
    name: "bff chat list: colleague's private chat hidden",
    as: "erin",
    method: "GET",
    path: CH,
    query: { project_id: p1 },
    setup: PRIVATE_CHAT,
    differs: M10,
  },
  {
    name: "bff chat list: limit zero",
    as: "alice",
    method: "GET",
    path: CH,
    query: { project_id: p1, limit: "0" },
  },
  { name: "bff chat list: no project", as: "alice", method: "GET", path: CH },
  {
    name: "bff chat list: observer refused",
    as: "rita",
    method: "GET",
    path: CH,
    query: { project_id: p2 },
    setup: P2_OPEN,
  },
  {
    name: "bff chat list: other tenant",
    as: "bob",
    method: "GET",
    path: CH,
    query: { project_id: p1 },
  },

  // ── GET /v2/bff/chats/{id} ────────────────────────────────────────
  { name: "bff chat get: owner", as: "alice", method: "GET", path: `${CH}/${chats.p1}` },
  {
    name: "bff chat get: external",
    as: "bob",
    method: "GET",
    path: `${CH}/${chat.p2}`,
    setup: [P2_OPEN, P2_CHAT],
  },
  { name: "bff chat get: missing", as: "alice", method: "GET", path: `${CH}/${MISSING}` },
  { name: "bff chat get: other tenant", as: "bob", method: "GET", path: `${CH}/${chats.p1}` },
  {
    name: "bff chat get: colleague's private chat",
    as: "erin",
    method: "GET",
    path: `${CH}/${chat.private}`,
    setup: PRIVATE_CHAT,
    differs: M10,
  },

  // ── PATCH /v2/bff/chats/{id} ──────────────────────────────────────
  {
    name: "bff chat rename",
    as: "alice",
    method: "PATCH",
    path: `${CH}/${chats.p1}`,
    body: { name: "Residents' wishes" },
    differs: UPDATER,
  },
  {
    name: "bff chat rename: nothing to change",
    as: "alice",
    method: "PATCH",
    path: `${CH}/${chats.p1}`,
    body: {},
  },
  {
    name: "bff chat rename: external (contributors may rename)",
    as: "bob",
    method: "PATCH",
    path: `${CH}/${chat.p2}`,
    body: { name: "x" },
    setup: [P2_OPEN, P2_CHAT],
    differs: UPDATER,
  },
  {
    name: "bff chat rename: observer refused",
    as: "rita",
    method: "PATCH",
    path: `${CH}/${chat.p2}`,
    body: { name: "x" },
    setup: [P2_OPEN, P2_CHAT],
  },
  {
    name: "bff chat rename: bad type",
    as: "alice",
    method: "PATCH",
    path: `${CH}/${chats.p1}`,
    body: { name: 5 },
  },

  // ── /v2/bff/chat-messages ─────────────────────────────────────────
  {
    name: "bff messages: list",
    as: "alice",
    method: "GET",
    path: MSG,
    query: { chat_id: chats.p1 },
  },
  {
    name: "bff messages: list limited",
    as: "alice",
    method: "GET",
    path: MSG,
    query: { chat_id: chats.p1, limit: "1" },
  },
  {
    name: "bff messages: limit too high",
    as: "alice",
    method: "GET",
    path: MSG,
    query: { chat_id: chats.p1, limit: "501" },
  },
  {
    name: "bff messages: other tenant",
    as: "bob",
    method: "GET",
    path: MSG,
    query: { chat_id: chats.p1 },
  },
  {
    name: "bff messages: post",
    as: "alice",
    method: "POST",
    path: MSG,
    body: {
      project_chat_id: chats.p1,
      message_from: "assistant",
      text: "Later buses, mostly.",
      template_key: "summary",
    },
  },
  {
    name: "bff messages: post observer refused",
    as: "rita",
    method: "POST",
    path: MSG,
    body: { project_chat_id: chat.p2, message_from: "user", text: "x" },
    setup: [P2_OPEN, P2_CHAT],
  },
  {
    name: "bff messages: post missing text",
    as: "alice",
    method: "POST",
    path: MSG,
    body: { project_chat_id: chats.p1, message_from: "user" },
  },
  {
    name: "bff messages: delete removed",
    as: "alice",
    method: "DELETE",
    path: `${MSG}/${SEED_MESSAGE}`,
    removed: "no client deletes a chat message",
  },
  {
    name: "bff messages: anonymous",
    as: "anonymous",
    method: "GET",
    path: MSG,
    query: { chat_id: chats.p1 },
  },
]);
