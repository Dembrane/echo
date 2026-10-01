import { projects, tags } from "../fixtures";
import { extra, P2_OPEN, P2_TAG } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2 } = projects;
const T = "/api/v2/bff/tags";
const R = "/api/v2/bff/analysis-runs";

export default scenarios([
  // ── /api/v2/bff/tags ──────────────────────────────────────────────
  { name: "tags list: owner", as: "alice", method: "GET", path: T, query: { project_id: p1 } },
  {
    name: "tags list: observer",
    as: "rita",
    method: "GET",
    path: T,
    query: { project_id: p2 },
    setup: [P2_OPEN, P2_TAG],
  },
  { name: "tags list: project required", as: "alice", method: "GET", path: T },
  { name: "tags list: other tenant", as: "bob", method: "GET", path: T, query: { project_id: p1 } },
  {
    name: "tags list: anonymous",
    as: "anonymous",
    method: "GET",
    path: T,
    query: { project_id: p1 },
  },
  {
    name: "tags create: owner",
    as: "alice",
    method: "POST",
    path: T,
    body: { project_id: p1, text: "housing", sort: 3 },
  },
  {
    name: "tags create: without sort",
    as: "admin",
    method: "POST",
    path: T,
    body: { project_id: p1, text: "noise" },
  },
  {
    name: "tags create: validation",
    as: "alice",
    method: "POST",
    path: T,
    body: { text: 5, sort: "x" },
  },
  {
    name: "tags create: observer refused",
    as: "rita",
    method: "POST",
    path: T,
    body: { project_id: p2, text: "x" },
    setup: [P2_OPEN],
  },
  {
    name: "tags create: other tenant",
    as: "bob",
    method: "POST",
    path: T,
    body: { project_id: p1, text: "x" },
  },
  {
    name: "tags update: owner",
    as: "alice",
    method: "PATCH",
    path: `${T}/${tags.p1Energy}`,
    body: { text: "Energy", sort: 5 },
  },
  {
    name: "tags update: nothing to update",
    as: "alice",
    method: "PATCH",
    path: `${T}/${tags.p1Energy}`,
    body: { text: null },
  },
  {
    name: "tags update: missing tag",
    as: "alice",
    method: "PATCH",
    path: `${T}/${extra.tag}`,
    body: { text: "x" },
  },
  {
    name: "tags update: other tenant",
    as: "bob",
    method: "PATCH",
    path: `${T}/${tags.p1Energy}`,
    body: { text: "x" },
  },
  {
    name: "tags update: observer refused",
    as: "rita",
    method: "PATCH",
    path: `${T}/${extra.tag}`,
    body: { text: "x" },
    setup: [P2_OPEN, P2_TAG],
  },
  {
    name: "tags delete: removed",
    as: "alice",
    method: "DELETE",
    path: `${T}/${tags.p1Mobility}`,
    removed:
      "no client calls it; the dashboard deletes through DELETE /api/projects/{id}/tags/{tag_id}",
  },

  // ── /api/v2/bff/analysis-runs, pruned with the old library ────────
  {
    name: "analysis runs list: removed",
    as: "alice",
    method: "GET",
    path: R,
    query: { project_id: p1 },
    removed: "the old library's analysis runs, pruned with it",
  },
  {
    name: "analysis runs get: removed",
    as: "alice",
    method: "GET",
    path: `${R}/${extra.run}`,
    removed: "the old library's analysis runs, pruned with it",
  },
  {
    name: "analysis runs new chunks: removed",
    as: "alice",
    method: "GET",
    path: `${R}/${extra.run}/new-chunks-count`,
    removed: "the old library's analysis runs, pruned with it",
  },
]);
