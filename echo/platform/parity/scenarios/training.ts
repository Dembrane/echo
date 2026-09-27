import { id, orgs } from "../fixtures";
import { scenarios } from "../runner/scenario";

const missing = id("99", 1);
const roster = (org: string) => `/api/v2/training/orgs/${org}/roster`;
const request = (org: string) => `/api/v2/training/orgs/${org}/request`;

export default scenarios([
  // Catalog
  {
    name: "training: catalog for a user",
    as: "alice",
    method: "GET",
    path: "/api/v2/training/catalog",
  },
  {
    name: "training: catalog refuses anonymous",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/training/catalog",
  },

  // Org roster
  {
    name: "training: owner reads roster with emails",
    as: "alice",
    method: "GET",
    path: roster(orgs.a),
  },
  { name: "training: org admin reads roster", as: "erin", method: "GET", path: roster(orgs.a) },
  {
    name: "training: org member sees only own email",
    as: "admin",
    method: "GET",
    path: roster(orgs.a),
  },
  {
    name: "training: roster of another org is refused",
    as: "bob",
    method: "GET",
    path: roster(orgs.a),
  },
  {
    name: "training: roster refuses a user outside the org",
    as: "rita",
    method: "GET",
    path: roster(orgs.a),
  },
  {
    name: "training: roster refuses a user not onboarded",
    as: "dave",
    method: "GET",
    path: roster(orgs.a),
  },
  {
    name: "training: roster refuses anonymous",
    as: "anonymous",
    method: "GET",
    path: roster(orgs.a),
  },
  {
    name: "training: other owner reads own roster",
    as: "bob",
    method: "GET",
    path: roster(orgs.b),
  },

  // Request
  {
    name: "training: owner requests an online training",
    differs:
      "staff inbox notice: the old audience_staff asks Directus 11 for a user field admin_access that no longer exists, finds no staff and notifies nobody; the port notifies every app user holding an admin-access policy",
    as: "alice",
    method: "POST",
    path: request(orgs.a),
    body: { type: "online" },
  },
  {
    name: "training: org admin requests in person with extras",
    differs:
      "staff inbox notice: the old audience_staff asks Directus 11 for a user field admin_access that no longer exists, finds no staff and notifies nobody; the port notifies every app user holding an admin-access policy",
    as: "erin",
    method: "POST",
    path: request(orgs.a),
    body: { type: "in_person", extra_participants: 3, notes: "Autumn cohort" },
  },
  {
    name: "training: org member may not request",
    as: "admin",
    method: "POST",
    path: request(orgs.a),
    body: { type: "online" },
  },
  {
    name: "training: request in another org is refused",
    as: "bob",
    method: "POST",
    path: request(orgs.a),
    body: { type: "online" },
  },
  {
    name: "training: flex cannot be requested",
    as: "alice",
    method: "POST",
    path: request(orgs.a),
    body: { type: "flex", extra_participants: -1 },
  },
  { name: "training: request without body", as: "alice", method: "POST", path: request(orgs.a) },
  {
    name: "training: request by user not onboarded",
    as: "dave",
    method: "POST",
    path: request(orgs.a),
    body: { type: "online" },
  },
  {
    name: "training: request refuses anonymous",
    as: "anonymous",
    method: "POST",
    path: request(orgs.a),
    body: { type: "online" },
  },

  // My licences
  {
    name: "training: own licences",
    as: "alice",
    method: "GET",
    path: "/api/v2/training/licenses/me",
  },
  {
    name: "training: own licences needs onboarding",
    as: "dave",
    method: "GET",
    path: "/api/v2/training/licenses/me",
  },
  {
    name: "training: own licences refuses anonymous",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/training/licenses/me",
  },

  // Staff: trainings
  {
    name: "training admin: staff lists trainings",
    as: "admin",
    method: "GET",
    path: "/api/v2/admin/trainings",
  },
  {
    name: "training admin: staff lists by org and status",
    as: "admin",
    method: "GET",
    path: "/api/v2/admin/trainings",
    query: { org_id: orgs.a, status: "requested" },
  },
  {
    name: "training admin: list refuses non-staff",
    as: "alice",
    method: "GET",
    path: "/api/v2/admin/trainings",
  },
  {
    name: "training admin: list refuses anonymous",
    as: "anonymous",
    method: "GET",
    path: "/api/v2/admin/trainings",
  },
  {
    name: "training admin: staff creates a scheduled training",
    as: "admin",
    method: "POST",
    path: "/api/v2/admin/trainings",
    body: {
      org_id: orgs.a,
      type: "in_person",
      extra_participants: 2,
      scheduled_at: "2026-11-02T09:00:00+00:00",
      notes: "On site",
      base_price_eur: 2200,
    },
  },
  {
    name: "training admin: staff creates a requested training",
    as: "admin",
    method: "POST",
    path: "/api/v2/admin/trainings",
    body: { org_id: orgs.b, type: "flex" },
  },
  {
    name: "training admin: create for a missing org",
    as: "admin",
    method: "POST",
    path: "/api/v2/admin/trainings",
    body: { org_id: missing, type: "online" },
  },
  {
    name: "training admin: create validates",
    as: "admin",
    method: "POST",
    path: "/api/v2/admin/trainings",
    body: { type: "webinar", base_price_eur: -5 },
  },
  {
    name: "training admin: create refuses non-staff",
    as: "alice",
    method: "POST",
    path: "/api/v2/admin/trainings",
    body: { org_id: orgs.a, type: "online" },
  },
  {
    name: "training admin: non-staff with bad body gets validation first",
    as: "alice",
    method: "POST",
    path: "/api/v2/admin/trainings",
    body: {},
  },
  {
    name: "training admin: update a missing training",
    as: "admin",
    method: "PATCH",
    path: `/api/v2/admin/trainings/${missing}`,
    body: { status: "scheduled" },
  },
  {
    name: "training admin: update validates status",
    as: "admin",
    method: "PATCH",
    path: `/api/v2/admin/trainings/${missing}`,
    body: { status: "done" },
  },
  {
    name: "training admin: update refuses non-staff",
    as: "erin",
    method: "PATCH",
    path: `/api/v2/admin/trainings/${missing}`,
    body: { status: "scheduled" },
  },
  {
    name: "training admin: staff reads an org roster",
    as: "admin",
    method: "GET",
    path: `/api/v2/admin/trainings/orgs/${orgs.a}/roster`,
  },
  {
    name: "training admin: staff roster refuses non-staff",
    as: "alice",
    method: "GET",
    path: `/api/v2/admin/trainings/orgs/${orgs.a}/roster`,
  },
  {
    name: "training admin: licences of an unknown training",
    as: "admin",
    method: "GET",
    path: `/api/v2/admin/trainings/${missing}/licenses`,
  },
  {
    name: "training admin: licences refuse non-staff",
    as: "alice",
    method: "GET",
    path: `/api/v2/admin/trainings/${missing}/licenses`,
  },
  {
    name: "training admin: complete a missing training",
    as: "admin",
    method: "POST",
    path: `/api/v2/admin/trainings/${missing}/complete`,
    body: { app_user_ids: [id("a0", 2)] },
  },
  {
    name: "training admin: complete needs at least one user",
    as: "admin",
    method: "POST",
    path: `/api/v2/admin/trainings/${missing}/complete`,
    body: { app_user_ids: [] },
  },
  {
    name: "training admin: complete refuses non-staff",
    as: "bob",
    method: "POST",
    path: `/api/v2/admin/trainings/${missing}/complete`,
    body: { app_user_ids: [id("a0", 2)] },
  },

  // Staff: licences
  {
    name: "training admin: update a missing licence",
    as: "admin",
    method: "PATCH",
    path: `/api/v2/admin/licenses/${missing}`,
    body: { status: "revoked" },
  },
  {
    name: "training admin: licence update validates status",
    as: "admin",
    method: "PATCH",
    path: `/api/v2/admin/licenses/${missing}`,
    body: { status: "paused" },
  },
  {
    name: "training admin: licence update refuses non-staff",
    as: "alice",
    method: "PATCH",
    path: `/api/v2/admin/licenses/${missing}`,
    body: { status: "revoked" },
  },
  {
    name: "training admin: revoke a missing licence",
    as: "admin",
    method: "POST",
    path: `/api/v2/admin/licenses/${missing}/revoke`,
  },
  {
    name: "training admin: revoke refuses non-staff",
    as: "alice",
    method: "POST",
    path: `/api/v2/admin/licenses/${missing}/revoke`,
  },
  {
    name: "training admin: revoke refuses anonymous",
    as: "anonymous",
    method: "POST",
    path: `/api/v2/admin/licenses/${missing}/revoke`,
  },
]);
