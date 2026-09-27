import { projects, webhooks } from "../fixtures";
import { extra, P2_WEBHOOK } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const { p1, p2, p3 } = projects;
const W = (p: string, tail = "") => `/api/projects/${p}/webhooks${tail}`;
const hook = webhooks.p1;
// Directus stamped the service account into user_created and user_updated; the platform
// records the person who acted. Those two columns are the only intended difference.
const who = ["user_created", "user_updated"];

export default scenarios([
  { name: "webhooks list: owner", as: "alice", method: "GET", path: W(p1) },
  { name: "webhooks list: member refused", as: "admin", method: "GET", path: W(p1) },
  { name: "webhooks list: free tier names the tier", as: "bob", method: "GET", path: W(p3) },
  { name: "webhooks list: other tenant", as: "bob", method: "GET", path: W(p1) },
  { name: "webhooks list: anonymous", as: "anonymous", method: "GET", path: W(p1) },
  {
    name: "webhooks list: staff without membership",
    as: "admin",
    method: "GET",
    path: W(p3),
    differs: "H-14: no blanket staff access to another tenant's webhooks",
  },
  { name: "webhooks copyable: nothing else", as: "alice", method: "GET", path: W(p1, "/copyable") },
  {
    name: "webhooks copyable: from projects the caller manages",
    as: "erin",
    method: "GET",
    path: W(p1, "/copyable"),
    setup: [P2_WEBHOOK],
  },
  {
    name: "webhooks copyable: not from projects out of reach",
    as: "alice",
    method: "GET",
    path: W(p1, "/copyable"),
    setup: [P2_WEBHOOK],
  },
  {
    name: "webhooks create: owner",
    as: "alice",
    method: "POST",
    path: W(p1),
    body: {
      name: "CRM",
      url: "https://example.com/in",
      secret: "s3cret",
      events: ["conversation.started"],
    },
    ignoreFields: who,
  },
  {
    name: "webhooks create: without secret",
    as: "erin",
    method: "POST",
    path: W(p1),
    body: { name: "Sheet", url: "http://example.com/in", events: [] },
    ignoreFields: who,
  },
  {
    name: "webhooks create: unknown event",
    as: "alice",
    method: "POST",
    path: W(p1),
    body: { name: "x", url: "https://example.com", events: ["conversation.deleted"] },
  },
  {
    name: "webhooks create: url scheme",
    as: "alice",
    method: "POST",
    path: W(p1),
    body: { name: "x", url: "ftp://example.com", events: [] },
  },
  {
    name: "webhooks create: validation",
    as: "alice",
    method: "POST",
    path: W(p1),
    body: { name: "x" },
  },
  {
    name: "webhooks create: member refused",
    as: "admin",
    method: "POST",
    path: W(p1),
    body: { name: "x", url: "https://example.com", events: [] },
  },
  {
    name: "webhooks update: rename and pause",
    as: "alice",
    method: "PATCH",
    path: W(p1, `/${hook}`),
    body: { name: "Renamed", status: "draft", events: ["report.generated"] },
    ignoreFields: who,
  },
  {
    name: "webhooks update: nothing sent",
    as: "alice",
    method: "PATCH",
    path: W(p1, `/${hook}`),
    body: {},
  },
  {
    name: "webhooks update: bad status",
    as: "alice",
    method: "PATCH",
    path: W(p1, `/${hook}`),
    body: { status: "paused" },
  },
  {
    name: "webhooks update: bad url",
    as: "alice",
    method: "PATCH",
    path: W(p1, `/${hook}`),
    body: { url: "example.com" },
  },
  {
    name: "webhooks update: webhook of another project",
    as: "erin",
    method: "PATCH",
    path: W(p1, `/${extra.webhook}`),
    body: { name: "x" },
    setup: [P2_WEBHOOK],
  },
  {
    name: "webhooks update: missing",
    as: "alice",
    method: "PATCH",
    path: W(p1, `/${extra.webhook}`),
    body: { name: "x" },
  },
  {
    name: "webhooks delete: owner",
    as: "alice",
    method: "DELETE",
    path: W(p1, `/${hook}`),
    ignoreFields: who,
  },
  {
    name: "webhooks delete: webhook of another project",
    as: "erin",
    method: "DELETE",
    path: W(p2, `/${hook}`),
  },
  {
    name: "webhooks delete: member refused",
    as: "admin",
    method: "DELETE",
    path: W(p1, `/${hook}`),
  },
  // The seeded URL refuses connections; each stack words the network error its own way.
  {
    name: "webhooks test: unreachable receiver",
    as: "alice",
    method: "POST",
    path: W(p1, `/${hook}/test`),
    ignoreFields: ["message"],
  },
  {
    name: "webhooks test: missing",
    as: "alice",
    method: "POST",
    path: W(p1, `/${extra.webhook}/test`),
  },
  { name: "webhooks test: other tenant", as: "bob", method: "POST", path: W(p1, `/${hook}/test`) },
]);
