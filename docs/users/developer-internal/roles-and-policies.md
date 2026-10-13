---
title: Roles and policies in code
description: How the access package decides who may do what. Roles, policy sets, tier gates, how a role is resolved for a workspace or a project, staff permissions, and how to add a policy.
audience: developer-internal
---

# Roles and policies in code

A role is a name on a membership row. What it allows is a set of policies, and code that guards an action asks for one policy by name. All of it lives in `dembrane/platform/packages/access/src`.

For what each role can do in plain words, read [roles and permissions](../../features/roles-and-permissions.md).

## The files

| File | What it holds |
|---|---|
| `policies.ts` | The workspace roles, every policy, the role presets (`ROLE_POLICIES`) and the tier gates (`TIER_REQUIRED`). |
| `org.ts` | The organisation roles and the customer account policies. |
| `resolve.ts` | Which role a person holds on a workspace or a project. |
| `authorize.ts` | The `Access` class: the one way a service obtains access. |
| `staff.ts` | The named staff permissions and their audit trail. |
| `store.ts`, `drizzle.ts`, `memory.ts` | The rows a decision reads: an interface, the Drizzle implementation, and an in-memory twin for tests. |

## Workspace roles and their policies

The workspace roles are `observer`, `external`, `member`, `billing`, `admin` and `owner`. A stored `viewer` is a legacy name and reads as `member`. The dashboard shows `owner` as "Admin".

The presets are built from four groups:

| Group | Policies |
|---|---|
| Read | `project:read`, `conversation:read`, `report:view` |
| Contribute | `project:update`, `chat:use`, `report:generate` |
| Manage | Deleting, sharing and moving projects, making a project private, deleting reports, `member:invite`, `member:manage`, `settings:manage`, and the workspace features such as `workspace:set_private`, `workspace:whitelabel` and `workspace:webhooks` |
| Billing | `workspace:view_usage`, `workspace:view_invoices`, `workspace:update_payment`, `upgrade:request` |

| Role | Holds |
|---|---|
| `observer` | Read |
| `external` | Read, Contribute |
| `member` | Read, Contribute, plus `project:create`, `conversation:delete`, `report:publish`, `workspace:view_usage` |
| `billing` | Billing only. No project data at all, not even a private project shared with them. |
| `admin` | Read, Contribute, Manage, Billing, plus `project:create`, `conversation:delete`, `report:publish` |
| `owner` | Every policy |

`ROLE_POLICIES` in `policies.ts` is the exact list. Read it before you rely on a detail.

A membership can also carry extra policies in its `custom_policies` column. Only known policy names count, so a stray value can never widen access. There is no interface for setting them.

### The rank is not a permission list

`ROLE_RANK` orders the roles: observer 0, external 1, member 2, billing 3, admin 4, owner 5. It is used only to stop someone giving a role above their own. `billing` ranks above `member` and can do far less.

## Tier gates

Some policies also need the workspace's billing account to be on a tier. The tiers, in order, are `free`, `innovator`, `changemaker` and `guardian`.

| Policy | Needs at least |
|---|---|
| `project:share`, `project:set_private`, `workspace:set_private` | Innovator |
| `workspace:whitelabel`, `workspace:webhooks` | Changemaker |

The table in code is `TIER_REQUIRED`. The tier is the tier of the billing account that pays for the workspace. It is not a column on the workspace.

## How a check runs

For a workspace or a project, a service does not read a membership row itself. It calls the `Access` class, usually through `projectFor` or `workspaceFor` from `@dembrane/http`, and names the policy it needs. The call has this shape:

```ts
const access = await projectFor(deps.access, who, projectId, "report:generate");
```

`Access` then does three things:

1. It resolves the caller's role on the project or workspace. When there is none, it throws a not-found error, so it does not confirm that the resource exists.
2. It checks the policy against the role's preset and the membership's extra policies. A missing policy is a 403 with the code `access.forbidden`.
3. It checks the tier gate, if the policy has one. A tier that is too low is a 403 with the code `billing.tier_required`, and the error carries the required tier.

The helpers in `@dembrane/http` wrap this and set the refusal each surface of the API sends. When a workspace is below the tier a policy needs, `projectFor` reports the tier gate first, whatever the role, because that is the upgrade the dashboard offers.

## How a role is resolved

`resolveWorkspace` and `resolveProject` in `resolve.ts` read only the store, so you can test them with the in-memory one.

For a workspace:

1. A direct, unexpired membership always wins, even when the organisation role would give more.
2. Otherwise the role is derived from the organisation role. An organisation `owner` is admin on every workspace of the organisation. An organisation `admin` is admin on workspaces that are open to the organisation. An organisation `member` gets a role only on workspaces that still carry a legacy inherit flag. An organisation `billing` role gives nothing.
3. A person who was removed from a workspace is not let back in through their organisation role. They return by a new invite.

For a project:

1. The caller needs a workspace role that holds `project:read`. That is why workspace `billing` gets no project data.
2. A project visible to the workspace is open to that role.
3. A private project is open to workspace admins and owners, and to others only with a share in `project_membership`. A share never crosses workspaces.

A user who has not finished onboarding has no `app_user` row and reaches no workspace.

## Organisation roles

The organisation roles are `member`, `billing`, `admin` and `owner`. There is no organisation-level external or observer.

Organisation actions are checked by role name, with `requireOrgRole` in `packages/tenancy/src/service/orgs.ts`. The only organisation policies are the five for the customer account: `account:read`, `account:sign`, `account:billing`, `account:tasks` and `account:support`. The `billing`, `admin` and `owner` roles hold all five. A plain `member` holds none.

Guards worth knowing when you touch membership code:

- Nobody can give a role above their own.
- The last admin or owner cannot be demoted, and the last owner cannot be removed.
- A person is an insider or an outsider of an organisation, never both. Someone who is `external` on a workspace cannot be made organisation admin or owner.

## Staff

Staff permissions are named, and every use is written to `staff_audit_event` before the action runs. `requireStaff` in `staff.ts` does both.

- The permissions are `staff:billing`, `staff:set_tier`, `staff:workspaces`, `staff:support_join`, `staff:training`, `staff:feedback`, `staff:accounts`, `staff:announcements`, `staff:privacy`, `staff:webhooks` and `staff:grant`.
- A person with the `Administrator` role holds all of them. Nobody else holds any.
- A staff API key is a staff session with a fixed list of these permissions, made from the command line with `bun run accounts:staff-key`. A key never causes an email to a customer: sending an offer with `notify`, sending a message or publishing a demo with the sign-in invitation answers 403 `staff.key_cannot_email` for a key and changes nothing. An offer sent without `notify` emails nobody, so a key may send it; the answer carries `customer_links` for the deal owner's own email. A signed-in person sends from the staff pages. `assertPersonSends` in the accounts package is the one place that decides it.
- No route can make someone staff. It is done from the command line with database access: `bun run staff:access list`, `grant <email> --by <staff-email>` or `revoke <email> --by <staff-email>`.
- Staff permissions never read customer project data. Staff reach it only through a support session, which is a workspace membership resolved like any other. A session the customer opened with the standing switch is read-only (`SUPPORT_READ_ONLY`). One approved through a request may act as an admin, but never on members, settings or deletion (`SUPPORT_APPROVED`).

[Staff support access](../../features/staff-support-access.md) describes this from the customer's side.

## Add a policy

1. Add the name to `POLICIES` in `policies.ts`. `owner` holds it at once, because the owner preset is every policy.
2. Add it to the group or the role presets that should hold it.
3. Add it to `TIER_REQUIRED` if a tier gates it.
4. Ask for it in the service, through `projectFor` or `workspaceFor`.
5. Extend the tests in `packages/access/test`.
6. Update [roles and permissions](../../features/roles-and-permissions.md) in the same pull request.

## Related

- [Roles and permissions](../../features/roles-and-permissions.md)
- [Tiers and billing](../../features/tiers-and-billing.md)
- [Staff support access](../../features/staff-support-access.md)
- [The data model](./data-model.md)
- [Architecture](./architecture.md)
- [Authentication](../developer-external/authentication.md)
