import { id } from "../fixtures";
import { scenarios } from "../runner/scenario";

// GET /api/home/search: the dashboard palette. Seed text: project "City listening 2026"
// (p1), conversations "Resident 1/2" on p1 and "Kickoff" on p3 (org B), chunks about
// charging points and buses, chat "What do residents want?" on p1.
const S = "/api/home/search";
const ERIN_BILLING = `update workspace_membership set role = 'billing' where id = '${id("e1", 2)}'`;

export default scenarios([
  {
    name: "search: owner finds conversations and chats",
    as: "alice",
    method: "GET",
    path: S,
    query: { query: "resident" },
  },
  {
    name: "search: tokens in any order",
    as: "alice",
    method: "GET",
    path: S,
    query: { query: "2026 city" },
  },
  {
    name: "search: transcripts by phrase",
    as: "alice",
    method: "GET",
    path: S,
    query: { query: "charging points" },
  },
  { name: "search: limit", as: "alice", method: "GET", path: S, query: { query: "e", limit: "1" } },
  {
    name: "search: blank after trimming",
    as: "alice",
    method: "GET",
    path: S,
    query: { query: "   " },
  },
  {
    name: "search: other tenant sees none of it",
    as: "bob",
    method: "GET",
    path: S,
    query: { query: "charging" },
  },
  {
    name: "search: other tenant finds its own",
    as: "bob",
    method: "GET",
    path: S,
    query: { query: "kickoff" },
  },
  {
    name: "search: staff are scoped too",
    as: "admin",
    method: "GET",
    path: S,
    query: { query: "o" },
  },
  { name: "search: observer", as: "rita", method: "GET", path: S, query: { query: "research" } },
  {
    name: "search: never onboarded",
    as: "dave",
    method: "GET",
    path: S,
    query: { query: "legacy" },
  },
  {
    name: "search: workspace billing role",
    as: "erin",
    method: "GET",
    path: S,
    query: { query: "resident" },
    setup: [ERIN_BILLING],
    differs: "M-5: search keeps only projects the caller may read; workspace billing may not",
  },
  { name: "search: query required", as: "alice", method: "GET", path: S },
  {
    name: "search: validation",
    as: "alice",
    method: "GET",
    path: S,
    query: { query: "x".repeat(121), limit: "0" },
  },
  {
    name: "search: anonymous",
    as: "anonymous",
    method: "GET",
    path: S,
    query: { query: "resident" },
  },
]);
