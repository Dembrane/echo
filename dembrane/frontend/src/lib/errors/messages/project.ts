import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const project = {
	"project.event_invite_paid": msg({
		id: "error.project.event_invite_paid",
		message:
			"Hiding the dembrane event invitation comes with a paid plan. Upgrade to hide it.",
	}),
	"project.events_dembrane_only": msg({
		id: "error.project.events_dembrane_only",
		message: "This setting is only for dembrane's own accounts.",
	}),
	"project.legal_basis_admin_only": msg({
		id: "error.project.legal_basis_admin_only",
		message:
			"Only workspace admins can change the legal basis of this project.",
	}),
	"project.legal_basis_invalid": msg({
		id: "error.project.legal_basis_invalid",
		message: "Pick one of the legal basis options.",
	}),
	"project.methodology_not_found": msg({
		id: "error.project.methodology_not_found",
		message: "We could not find this methodology. It may have been deleted.",
	}),
	"project.methodology_read_only": msg({
		id: "error.project.methodology_read_only",
		message:
			"The dembrane methodology cannot be changed. Make a copy to edit it.",
	}),
	"project.move_context_mismatch": msg({
		id: "error.project.move_context_mismatch",
		message:
			"Projects can only move between workspaces with the same billing and data owner. Pick another workspace.",
	}),
	"project.move_needs_admin": msg({
		id: "error.project.move_needs_admin",
		message:
			"To move projects, you need to be an admin or owner of the {side} workspace.",
	}),
	"project.move_no_workspace_access": msg({
		id: "error.project.move_no_workspace_access",
		message: "You do not have access to the {side} workspace.",
	}),
	"project.move_none_selected": msg({
		id: "error.project.move_none_selected",
		message: "Select at least one project to move.",
	}),
	"project.move_target_not_found": msg({
		id: "error.project.move_target_not_found",
		message:
			"We could not find the workspace you picked. It may have been deleted.",
	}),
	"project.move_too_many": msg({
		id: "error.project.move_too_many",
		message:
			"You can move up to {max} projects at a time. Select fewer and try again.",
	}),
	"project.no_access": msg({
		id: "error.project.no_access",
		message: "You do not have access to this project.",
	}),
	"project.no_conversations": msg({
		id: "error.project.no_conversations",
		message: "This project has no conversations yet.",
	}),
	"project.no_transcripts": msg({
		id: "error.project.no_transcripts",
		message: "This project has no transcripts yet.",
	}),
	"project.no_workspace": msg({
		id: "error.project.no_workspace",
		message:
			"This project is not part of a workspace, so this setting is not available. Contact support to move it.",
	}),
	"project.not_found": msg({
		id: "error.project.not_found",
		message:
			"We could not find this project. It may have been deleted, or you may not have access.",
	}),
	"project.not_in_workspace": msg({
		id: "error.project.not_in_workspace",
		message:
			"This project is not in this workspace. Pick a project from this workspace.",
	}),
	"project.not_owner": msg({
		id: "error.project.not_owner",
		message: "Only the owner of this project can do this.",
	}),
	"project.pin_order_invalid": msg({
		id: "error.project.pin_order_invalid",
		message: "A project can be pinned in place 1, 2 or 3.",
	}),
	"project.privacy_policy_invalid_url": msg({
		id: "error.project.privacy_policy_invalid_url",
		message:
			"Enter a privacy policy link that starts with http:// or https://.",
	}),
	"project.privacy_policy_required": msg({
		id: "error.project.privacy_policy_required",
		message:
			"Add a link to your privacy policy to use consent as the legal basis.",
	}),
	"project.privacy_policy_too_long": msg({
		id: "error.project.privacy_policy_too_long",
		message:
			"This privacy policy link is too long. Use a link of at most 255 characters.",
	}),
	"project.private_requires_tier": msg({
		id: "error.project.private_requires_tier",
		message:
			"Private projects come with the Innovator plan and above. Upgrade to make this project private.",
	}),
	"project.share_admin_only": msg({
		id: "error.project.share_admin_only",
		message: "Only workspace admins can share projects.",
	}),
	"project.share_needs_private": msg({
		id: "error.project.share_needs_private",
		message:
			"Everyone in the workspace can already see this project. Make it private first to share it with individual people.",
	}),
	"project.share_not_found": msg({
		id: "error.project.share_not_found",
		message: "This project is no longer shared with that person.",
	}),
	"project.share_not_member": msg({
		id: "error.project.share_not_member",
		message:
			"This person is not in the workspace yet. Invite them to the workspace first.",
	}),
	"project.share_role_cannot_access": msg({
		id: "error.project.share_role_cannot_access",
		message:
			"Billing members cannot open projects. Give them another role first.",
	}),
	"project.sharing_tier_required": msg({
		id: "error.project.sharing_tier_required",
		message:
			"Sharing a private project with people needs the {tier} plan or higher.",
	}),
	"project.visibility_admin_only": msg({
		id: "error.project.visibility_admin_only",
		message: "Only workspace admins can change who sees this project.",
	}),
} satisfies Messages<"project">;
