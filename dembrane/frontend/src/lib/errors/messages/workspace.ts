import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const workspace = {
	"workspace.access_request_actioned": msg({
		id: "error.workspace.access_request_actioned",
		message: "Someone already answered this request.",
	}),
	"workspace.access_request_not_found": msg({
		id: "error.workspace.access_request_not_found",
		message: "We could not find this request. It may have been withdrawn.",
	}),
	"workspace.admin_joins_directly": msg({
		id: "error.workspace.admin_joins_directly",
		message:
			"As an organisation admin you can join this workspace directly, no request needed.",
	}),
	"workspace.create_admin_only": msg({
		id: "error.workspace.create_admin_only",
		message: "Only organisation admins and owners can create workspaces here.",
	}),
	"workspace.data_owner_is_member": msg({
		id: "error.workspace.data_owner_is_member",
		message:
			"This data owner is already in your organisation. For an external client, name someone outside it, or create an internal workspace instead.",
	}),
	"workspace.data_owner_org_required": msg({
		id: "error.workspace.data_owner_org_required",
		message: "Add the name of the organisation that owns the data.",
	}),
	"workspace.data_ownership_admin_only": msg({
		id: "error.workspace.data_ownership_admin_only",
		message:
			"Only an organisation admin can change who owns this workspace's data.",
	}),
	"workspace.delete_admin_only": msg({
		id: "error.workspace.delete_admin_only",
		message: "Only a workspace admin or owner can delete this workspace.",
	}),
	"workspace.deleted": msg({
		id: "error.workspace.deleted",
		message: "This workspace no longer exists.",
	}),
	"workspace.external_needs_owner": msg({
		id: "error.workspace.external_needs_owner",
		message:
			"Add the client organisation's name and the data owner's email to mark this workspace as external.",
	}),
	"workspace.handoff_accept_target_admin_only": msg({
		id: "error.workspace.handoff_accept_target_admin_only",
		message:
			"Only admins of the receiving organisation can accept this handover.",
	}),
	"workspace.handoff_admin_only": msg({
		id: "error.workspace.handoff_admin_only",
		message:
			"Only admins of the organisation that pays for this workspace can hand it over.",
	}),
	"workspace.handoff_cancel_initiator_only": msg({
		id: "error.workspace.handoff_cancel_initiator_only",
		message:
			"Only admins of the organisation that started this handover can cancel it.",
	}),
	"workspace.handoff_none_pending": msg({
		id: "error.workspace.handoff_none_pending",
		message: "There is no handover waiting for this workspace.",
	}),
	"workspace.handoff_pending": msg({
		id: "error.workspace.handoff_pending",
		message:
			"A handover is already waiting for this workspace. Cancel it before you start a new one.",
	}),
	"workspace.handoff_same_org": msg({
		id: "error.workspace.handoff_same_org",
		message:
			"This organisation already pays for this workspace. Pick another one.",
	}),
	"workspace.handoff_shared_plan": msg({
		id: "error.workspace.handoff_shared_plan",
		message:
			"This workspace is on your organisation's shared plan, so it cannot be handed over. Only workspaces with their own billing can move.",
	}),
	"workspace.handoff_target_not_found": msg({
		id: "error.workspace.handoff_target_not_found",
		message:
			"We could not find that organisation. Check the name and try again.",
	}),
	"workspace.has_projects": msg({
		id: "error.workspace.has_projects",
		message:
			"This workspace still has {count, plural, one {# project} other {# projects}}. Delete or move them first from your organisation's Projects page.",
	}),
	"workspace.logo_url_invalid": msg({
		id: "error.workspace.logo_url_invalid",
		message: "Use a logo link that starts with http:// or https://.",
	}),
	"workspace.logo_url_too_long": msg({
		id: "error.workspace.logo_url_too_long",
		message: "This logo link is too long. Use a shorter link.",
	}),
	"workspace.no_access": msg({
		id: "error.workspace.no_access",
		message: "You are not a member of this workspace.",
	}),
	"workspace.not_found": msg({
		id: "error.workspace.not_found",
		message:
			"We could not find this workspace. It may have been deleted, or you may not have access.",
	}),
	"workspace.paid_rescope": msg({
		id: "error.workspace.paid_rescope",
		message:
			"This workspace has paid billing, so we cannot switch it between internal and external for you. Contact support to move the billing first.",
	}),
	"workspace.partner_agreement_required": msg({
		id: "error.workspace.partner_agreement_required",
		message: "Accept the partner agreement to continue.",
	}),
	"workspace.private": msg({
		id: "error.workspace.private",
		message: "This workspace is private. Ask a workspace admin to invite you.",
	}),
	"workspace.removed_from": msg({
		id: "error.workspace.removed_from",
		message:
			"You were removed from this workspace. Ask a workspace admin to invite you back.",
	}),
	"workspace.support_request_expired": msg({
		id: "error.workspace.support_request_expired",
		message:
			"This support request has expired. Ask dembrane support to send a new one if you still need help.",
	}),
	"workspace.support_request_handled": msg({
		id: "error.workspace.support_request_handled",
		message: "This support request was already answered.",
	}),
	"workspace.visibility_requires_tier": msg({
		id: "error.workspace.visibility_requires_tier",
		message:
			"Invite-only and private workspaces need the Innovator plan or higher. Create it as open for now, or upgrade first.",
	}),
} satisfies Messages<"workspace">;
