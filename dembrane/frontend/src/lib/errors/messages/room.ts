import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

/** The data room of a customer account: who brings whom in, changes and takes out. */
export const room = {
	"room.in_by_role": msg({
		id: "error.room.in_by_role",
		message:
			"Owners, admins and Billing are in the room by their role. Change their role on the Members page instead.",
	}),
	"room.labels_already_answered": msg({
		id: "error.room.labels_already_answered",
		message: "You already said what you do here.",
	}),
	"room.manage_forbidden": msg({
		id: "error.room.manage_forbidden",
		message:
			"Only the person who invited them, an admin or Billing can change what they do.",
	}),
	"room.new_person_admins_only": msg({
		id: "error.room.new_person_admins_only",
		message:
			"Only an owner or admin can invite someone who is not a member yet. You can add a colleague who is already a member.",
	}),
	"room.no_labels_question": msg({
		id: "error.room.no_labels_question",
		message: "There is nothing to answer here.",
	}),
	"room.person_not_found": msg({
		id: "error.room.person_not_found",
		message: "This person is no longer in the room.",
	}),
	"room.remove_forbidden": msg({
		id: "error.room.remove_forbidden",
		message:
			"Only the person who invited them, an admin or Billing can take them out.",
	}),
} satisfies Messages<"room">;
