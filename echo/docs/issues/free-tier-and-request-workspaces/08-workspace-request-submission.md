# Workspace request submission (collection + endpoint + wizard)

## What to build

A new `workspace_request` Directus collection captures user-submitted requests for either a new workspace at a paid tier, or a tier upgrade on an existing workspace. A new `POST /v2/workspace-requests` endpoint accepts authenticated submissions with role validation (org admin/owner for `kind=new_workspace`; workspace admin/billing for `kind=tier_upgrade`).

The existing 4-step workspace creation wizard's final button changes from "Create workspace" to "Request workspace" and submits to the new endpoint. The tier picker offers paid tiers only — `pilot`, `pioneer`, `innovator`, `changemaker`, `guardian` — with `innovator` as the default selection. The picker visibly shows what each tier includes (seats, hours, overage rules). `free` is never offered.

On success the wizard does not redirect or create a workspace. Instead the modal shows a confirmation panel: "Request submitted, we'll be in touch within 1 business day."

Discounts are NOT user-proposable. Users supply context for a discount conversation in `requester_message` (free text, max 1000 chars).

The collection schema:

- Identity: `id`, `kind` (`new_workspace` | `tier_upgrade`), `status` (`pending` | `approved` | `denied`, default `pending`).
- Requester side: `requested_by`, `org_id`, `workspace_id` (nullable, set for upgrades), `proposed_name`, `proposed_tier` (default `innovator`), `proposed_visibility` (default `open_to_organisation`), `requester_message`.
- Approval side (written later by staff): `granted_tier`, `granted_tier_expires_at`, `granted_type_discount`, `granted_percent_discount`, `resulting_workspace_id`.
- Decision: `decided_at`, `decided_by`, `denial_reason`.
- Internal: `staff_notes` (staff-only field permission). Plus standard `created_at` / `updated_at`.

Use the established pattern of a Python script against the Directus REST API (idempotent, check-then-create) to land the schema, then pull the sync snapshot — do not hand-write the JSON.

## Acceptance criteria

- [ ] `workspace_request` collection exists in Directus with the fields above and correct row-level + field-level permissions.
- [ ] `staff_notes` is locked to the staff role at the field level.
- [ ] `POST /v2/workspace-requests` validates the user's role for the requested kind and creates a pending row.
- [ ] Submitting for `kind=new_workspace` requires the user to be org admin or owner of the target org.
- [ ] Submitting for `kind=tier_upgrade` requires the user to be workspace admin or billing on the target workspace.
- [ ] The wizard's last step button reads "Request workspace" (not "Create workspace") and submits to the new endpoint.
- [ ] The tier picker shows `pilot`/`pioneer`/`innovator`/`changemaker`/`guardian` only; `innovator` is the default; the per-tier capacity is visible to the user.
- [ ] `free` is not selectable in the picker.
- [ ] Wizard success state shows the confirmation panel "Request submitted, we'll be in touch within 1 business day" and does not create a workspace.
- [ ] The schema is landed via an idempotent Python script and the sync snapshot is pulled and committed.

## Blocked by

None — can start immediately.
