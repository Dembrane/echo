import { chats, id } from "../fixtures";
import { scenarios } from "../runner/scenario";

const assistant = id("c4", 2);
const userMsg = id("c4", 1);
const missing = id("c4", 99);
const R = "/api/v2/feedback/responses";

export default scenarios([
  // Issue reports: the runner sends JSON, which carries no form fields, so these prove
  // auth and validation; the multipart success path is proven in packages/feedback tests.
  {
    name: "feedback report: anonymous is refused",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/feedback/reports",
    body: { message: "x" },
  },
  {
    name: "feedback report: a JSON body has no message field",
    as: "alice",
    method: "POST",
    path: "/api/v2/feedback/reports",
    body: { message: "x" },
  },
  {
    name: "feedback report: no body at all",
    as: "alice",
    method: "POST",
    path: "/api/v2/feedback/reports",
  },

  {
    name: "feedback attachment: anonymous is refused",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/feedback/attachments/r1/a.png",
  },
  {
    name: "feedback attachment: a customer is refused",
    as: "alice",
    method: "GET",
    path: "/api/v2/feedback/attachments/r1/a.png",
  },
  {
    name: "feedback attachment: staff, traversal refused",
    as: "admin",
    method: "GET",
    path: "/api/v2/feedback/attachments/r1/a..png",
  },
  {
    name: "feedback attachment: staff, missing object",
    as: "admin",
    method: "GET",
    path: "/api/v2/feedback/attachments/r1/a.png",
  },

  // Rating an assistant message.
  {
    name: "feedback response: alice rates the assistant up",
    as: "alice",
    method: "PUT",
    path: R,
    body: {
      target_type: "chat_message",
      target_id: assistant,
      rating: "up",
      reasons: ["incorrect"],
      comment: "  nice  ",
    },
  },
  {
    name: "feedback response: erin rates down with reasons",
    as: "erin",
    method: "PUT",
    path: R,
    body: {
      target_type: "chat_message",
      target_id: assistant,
      rating: "down",
      reasons: ["incorrect", "other", "incorrect"],
      comment: "",
      session_replay_url: "https://eu.posthog.com/replay/1",
    },
  },
  {
    name: "feedback response: staff member of the workspace rates",
    as: "admin",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: assistant, rating: "down" },
  },
  {
    name: "feedback response: a user message cannot be rated",
    as: "alice",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: userMsg, rating: "up" },
  },
  {
    name: "feedback response: outsider gets not found",
    as: "bob",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: assistant, rating: "up" },
  },
  {
    name: "feedback response: observer elsewhere gets not found",
    as: "rita",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: assistant, rating: "up" },
  },
  {
    name: "feedback response: not onboarded",
    as: "dave",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: assistant, rating: "up" },
  },
  {
    name: "feedback response: unknown message",
    as: "alice",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: missing, rating: "up" },
  },
  {
    name: "feedback response: unknown target type",
    as: "alice",
    method: "PUT",
    path: R,
    body: { target_type: "report", target_id: assistant, rating: "up" },
  },
  {
    name: "feedback response: bad rating",
    as: "alice",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: assistant, rating: "meh" },
  },
  {
    name: "feedback response: unknown reason",
    as: "alice",
    method: "PUT",
    path: R,
    body: { target_type: "chat_message", target_id: assistant, rating: "down", reasons: ["rude"] },
  },
  {
    name: "feedback response: body validation",
    as: "alice",
    method: "PUT",
    path: R,
    body: { target_type: 1, target_id: "", rating: "x", reasons: "a" },
  },
  { name: "feedback response: anonymous", as: "anonymous", method: "PUT", path: R, body: {} },

  {
    name: "feedback responses: own list",
    as: "alice",
    method: "GET",
    path: R,
    query: { target_type: "chat_message", target_ids: `${assistant}, ${userMsg},,` },
  },
  {
    name: "feedback responses: empty id list",
    as: "alice",
    method: "GET",
    path: R,
    query: { target_type: "chat_message", target_ids: " , " },
  },
  {
    name: "feedback responses: unknown type",
    as: "alice",
    method: "GET",
    path: R,
    query: { target_type: "x", target_ids: "a" },
  },
  { name: "feedback responses: missing query", as: "alice", method: "GET", path: R },

  { name: "feedback admin: staff reads the page", as: "admin", method: "GET", path: `${R}/admin` },
  {
    name: "feedback admin: staff filters",
    as: "admin",
    method: "GET",
    path: `${R}/admin`,
    query: {
      rating: "down",
      target_type: "chat_message",
      reason: "other",
      chat_mode: "deep_dive",
      date_from: "2020-01-01T00:00:00Z",
      date_to: "2099-01-01",
      page: "2",
      limit: "10",
    },
  },
  {
    name: "feedback admin: bad rating filter",
    as: "admin",
    method: "GET",
    path: `${R}/admin`,
    query: { rating: "meh" },
  },
  {
    name: "feedback admin: bad reason filter",
    as: "admin",
    method: "GET",
    path: `${R}/admin`,
    query: { reason: "meh" },
  },
  {
    name: "feedback admin: bad chat mode",
    as: "admin",
    method: "GET",
    path: `${R}/admin`,
    query: { chat_mode: "meh" },
  },
  {
    name: "feedback admin: bad date",
    as: "admin",
    method: "GET",
    path: `${R}/admin`,
    query: { date_from: "yesterday" },
  },
  {
    name: "feedback admin: paging bounds",
    as: "admin",
    method: "GET",
    path: `${R}/admin`,
    query: { page: "0", limit: "500" },
  },
  { name: "feedback admin: a customer is refused", as: "alice", method: "GET", path: `${R}/admin` },

  {
    name: "feedback responses: delete when none exists",
    as: "alice",
    method: "DELETE",
    path: `${R}/chat_message/${assistant}`,
  },
  {
    name: "feedback responses: delete unknown type",
    as: "alice",
    method: "DELETE",
    path: `${R}/x/${assistant}`,
  },
  {
    name: "feedback responses: delete anonymous",
    as: "anonymous",
    method: "DELETE",
    path: `${R}/chat_message/${chats.p1}`,
  },
]);
