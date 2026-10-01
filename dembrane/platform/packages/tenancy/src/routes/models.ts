import { p } from "@dembrane/legacy-shape";

/**
 * The request models of the tenancy routes, field for field as the old API's pydantic
 * models declared them (order matters: pydantic reports errors in declaration order).
 */
const optStr = (opts: { min?: number; max?: number } = {}) =>
  p.optional(p.nullable(p.str(opts)), null);
const optBool = () => p.optional(p.nullable(p.bool()), null);

export const CreateWorkspace = p.model({
  name: p.required(p.str({ min: 1, max: 100 })),
  org_id: optStr(),
  visibility: p.optional(
    p.literal("open_to_organisation", "invite_only", "private"),
    "open_to_organisation",
  ),
  // Accepted for old clients and ignored: org members no longer inherit access.
  inherit_organisation_members: p.optional(p.bool(), false),
  data_owner_org_name: optStr({ max: 255 }),
  data_owner_email: p.optional(p.nullable(p.email()), null),
  partner_agreement_accepted: p.optional(p.bool(), false),
});

/** Legacy pilot and pioneer are refused here: they disabled every paid feature (spec L-17). */
export const SetTier = p.model({
  tier: p.required(p.literal("free", "innovator", "changemaker", "guardian")),
  reason: p.required(p.str({ min: 1, max: 500 })),
});

export const PreviewDowngradeQuery = {
  to_tier: p.required(p.literal("pilot", "pioneer", "innovator", "changemaker", "guardian")),
};

/** `refresh` bypassed a cache the platform does not keep; it is still validated. */
export const UsageQuery = {
  refresh: p.optional(p.bool(), false),
  month_offset: p.optional(p.int(), 0),
};

export const HandoffInitiate = p.model({
  target_organisation_id: p.required(p.str()),
  message: optStr({ max: 1000 }),
});

export const UpdateSettings = p.model({
  name: optStr(),
  description: optStr(),
  context: optStr(),
  logo_url: optStr(),
  visibility: p.optional(
    p.nullable(p.literal("open_to_organisation", "invite_only", "private")),
    null,
  ),
  // Accepted and ignored: org members no longer inherit workspace access.
  inherit_organisation_members: optBool(),
  allow_support_access: optBool(),
  legal_basis: p.optional(
    p.nullable(p.literal("client-managed", "consent", "dembrane-events")),
    null,
  ),
  privacy_policy_url: optStr(),
});

export const DataOwnership = p.model({
  usage_context: p.optional(p.nullable(p.literal("internal", "external")), null),
  data_owner_org_name: optStr(),
  data_owner_email: optStr(),
  partner_agreement_accepted: optBool(),
});

export const ChangeRole = p.model({ role: p.required(p.str()) });

export const ProjectListQuery = {
  search: optStr(),
  offset: p.optional(p.int({ ge: 0 }), 0),
  limit: p.optional(p.int({ ge: 1, le: 100 }), 15),
};

export const CreateProject = p.model({
  name: p.optional(p.str(), "New Project"),
  language: p.optional(p.str(), "en"),
});

export const SupportEventsQuery = {
  page: p.optional(p.int({ ge: 1 }), 1),
  limit: p.optional(p.int({ ge: 1, le: 100 }), 20),
};

export const AddShare = p.model({ email: p.required(p.email()) });

export const CreateOrg = p.model({ name: p.required(p.str({ min: 1, max: 100 })) });

export const UpdateOrg = p.model({
  name: optStr({ min: 1, max: 100 }),
  description: optStr({ max: 2000 }),
  logo_url: optStr(),
});

export const PendingInvitesQuery = { workspace_id: optStr() };

export const InviteToOrg = p.model({
  email: p.required(p.email()),
  role: p.optional(p.literal("member", "admin", "billing", "owner"), "member"),
});
