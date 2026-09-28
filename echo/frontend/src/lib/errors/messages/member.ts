import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const member = {
	"member.already_removed": msg({
		id: "error.member.already_removed",
		message: "This person was already removed.",
	}),
	"member.changed_concurrently": msg({
		id: "error.member.changed_concurrently",
		message: "Someone changed this membership at the same time. Try again.",
	}),
	"member.invalid_role": msg({
		id: "error.member.invalid_role",
		message: "That role is not available here. Pick one from the list.",
	}),
	"member.last_admin": msg({
		id: "error.member.last_admin",
		message:
			"This is the last admin. Make someone else an admin or owner first.",
	}),
	"member.last_admin_remove": msg({
		id: "error.member.last_admin_remove",
		message:
			"This is the last admin. Make someone else an admin first, then remove them.",
	}),
	"member.last_owner": msg({
		id: "error.member.last_owner",
		message: "This is the last owner. Hand ownership to someone else first.",
	}),
	"member.last_owner_demote": msg({
		id: "error.member.last_owner_demote",
		message: "This is the last owner. Make someone else an owner first.",
	}),
	"member.not_found": msg({
		id: "error.member.not_found",
		message:
			"This person is not a member anymore. Refresh the page to see the current list.",
	}),
	"member.not_in_workspace": msg({
		id: "error.member.not_in_workspace",
		message:
			"This person is not a member of this workspace. Refresh the page to see the current list.",
	}),
	"member.outsider_role_switch": msg({
		id: "error.member.outsider_role_switch",
		message:
			"You cannot switch between an outside collaborator and a member here. Invite them again with the new role.",
	}),
	"member.owner_changes_owner": msg({
		id: "error.member.owner_changes_owner",
		message:
			"Only an owner can make someone an owner or change another owner's role.",
	}),
	"member.owner_removes_owner": msg({
		id: "error.member.owner_removes_owner",
		message: "Only an owner can remove another owner.",
	}),
	"member.role_above_own": msg({
		id: "error.member.role_above_own",
		message: "You cannot give someone a higher role than your own.",
	}),
	"member.sole_admin_leave": msg({
		id: "error.member.sole_admin_leave",
		message:
			"You are the only admin. Make someone else an admin before you leave.",
	}),
} satisfies Messages<"member">;
