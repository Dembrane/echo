import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const invite = {
	"invite.already_accepted": msg({
		id: "error.invite.already_accepted",
		message: "This invite has already been accepted.",
	}),
	"invite.expired": msg({
		id: "error.invite.expired",
		message:
			"This invite has expired. Ask the person who invited you to send a new one.",
	}),
	"invite.not_for_you": msg({
		id: "error.invite.not_for_you",
		message:
			"This invite was sent to a different email address. Sign in with that address to accept it.",
	}),
	"invite.not_found": msg({
		id: "error.invite.not_found",
		message:
			"We could not find this invite. It may have been withdrawn or already used.",
	}),
	"invite.observer_internal_workspace": msg({
		id: "error.invite.observer_internal_workspace",
		message:
			"Observers can only join workspaces for an external client. Pick another role.",
	}),
	"invite.outsider_is_admin": msg({
		id: "error.invite.outsider_is_admin",
		message:
			"This person has an admin, owner or billing role in your organisation, so they cannot join as an outside collaborator. Change their role first.",
	}),
	"invite.outsider_is_member": msg({
		id: "error.invite.outsider_is_member",
		message:
			"This person is already a member of your organisation, so they cannot join as an outside collaborator.",
	}),
	"invite.resend_forbidden": msg({
		id: "error.invite.resend_forbidden",
		message:
			"Only the person who sent this invite or an organisation admin can resend it.",
	}),
	"invite.revoke_forbidden": msg({
		id: "error.invite.revoke_forbidden",
		message:
			"Only the person who sent this invite or an admin can withdraw it.",
	}),
	"invite.role_cannot_access_projects": msg({
		id: "error.invite.role_cannot_access_projects",
		message:
			"Billing members cannot open projects. Pick another role to share this project.",
	}),
	"invite.self": msg({
		id: "error.invite.self",
		message: "You cannot invite yourself.",
	}),
} satisfies Messages<"invite">;
