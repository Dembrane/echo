import { id, orgs, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const n = (k: number) => id("ab", k);
const at = (min: number) => `'2026-09-01T10:${String(min).padStart(2, "0")}:00Z'`;

// Alice's inbox: two unread (one from Erin with refs and params), one read, one expired;
// one row belongs to Bob.
const inbox = `
insert into notification (id, audience_user_id, actor_user_id, event_code, severity, action, title, message, scope, params, ref_org_id, ref_workspace_id, created_at, updated_at, read_at, expires_at) values
 ('${n(1)}', '${users.alice.app}', '${users.erin.app}', 'INVITE_ACCEPTED', 'info', 'NAVIGATE_WORKSPACE_SETTINGS', 'Erin joined Default', 'They accepted.', 'Parity Org A › Default', '{"k": 1}', '${orgs.a}', '${workspaces.aDefault}', ${at(1)}, ${at(1)}, null, null),
 ('${n(2)}', '${users.alice.app}', null, 'TIER_EXPIRING_SOON', 'action_required', 'NAVIGATE_BILLING', 'Plan expiring', null, null, null, null, null, ${at(2)}, ${at(2)}, null, '2099-01-01T00:00:00Z'),
 ('${n(3)}', '${users.alice.app}', null, 'WORKSPACE_ADDED', 'info', 'NAVIGATE_WS', 'Read one', null, null, null, null, null, ${at(3)}, ${at(3)}, ${at(4)}, null),
 ('${n(4)}', '${users.alice.app}', null, 'WORKSPACE_ADDED', 'info', 'NAVIGATE_WS', 'Expired unread', null, null, null, null, null, ${at(5)}, ${at(5)}, null, '2026-01-01T00:00:00Z'),
 ('${n(5)}', '${users.bob.app}', null, 'WORKSPACE_ADDED', 'info', 'NAVIGATE_WS', 'Bob only', null, null, null, null, null, ${at(6)}, ${at(6)}, null, null);
`;

const base = "/api/v2/me/notifications";

export default scenarios([
  {
    name: "notifications: alice lists her unexpired inbox",
    as: "alice",
    method: "GET",
    path: base,
    setup: inbox,
  },
  {
    name: "notifications: unread only, limit 1",
    as: "alice",
    method: "GET",
    path: base,
    query: { unread_only: "true", limit: "1" },
    setup: inbox,
  },
  {
    name: "notifications: limit below 1 is clamped to 1",
    as: "alice",
    method: "GET",
    path: base,
    query: { limit: "0" },
    setup: inbox,
  },
  { name: "notifications: empty inbox", as: "rita", method: "GET", path: base, setup: inbox },
  {
    name: "notifications: bad query parameters are 422",
    as: "alice",
    method: "GET",
    path: base,
    query: { limit: "abc", unread_only: "maybe" },
  },
  { name: "notifications: not onboarded is 403", as: "dave", method: "GET", path: base },
  { name: "notifications: anonymous is 401", as: "anonymous", method: "GET", path: base },
  {
    name: "notifications: unread count skips read and expired rows",
    as: "alice",
    method: "GET",
    path: `${base}/unread-count`,
    setup: inbox,
  },
  {
    name: "notifications: unread count, not onboarded",
    as: "dave",
    method: "GET",
    path: `${base}/unread-count`,
  },
  {
    name: "notifications: mark one read",
    as: "alice",
    method: "POST",
    path: `${base}/${n(1)}/read`,
    setup: inbox,
  },
  {
    name: "notifications: marking a read row again changes nothing",
    as: "alice",
    method: "POST",
    path: `${base}/${n(3)}/read`,
    setup: inbox,
  },
  {
    name: "notifications: another user's row is 404",
    as: "alice",
    method: "POST",
    path: `${base}/${n(5)}/read`,
    setup: inbox,
  },
  {
    name: "notifications: unknown id is 404",
    as: "alice",
    method: "POST",
    path: `${base}/${n(9)}/read`,
  },
  {
    name: "notifications: malformed id is 404",
    as: "alice",
    method: "POST",
    path: `${base}/xyz/read`,
  },
  {
    name: "notifications: read all marks every unread row, expired included",
    as: "alice",
    method: "POST",
    path: `${base}/read-all`,
    setup: inbox,
  },
  {
    name: "notifications: read all with nothing unread",
    as: "rita",
    method: "POST",
    path: `${base}/read-all`,
  },
  {
    name: "notifications: read all, anonymous",
    as: "anonymous",
    method: "POST",
    path: `${base}/read-all`,
  },
]);
