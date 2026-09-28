import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const organisation = {
	"organisation.admin_only": msg({
		id: "error.organisation.admin_only",
		message: "Only organisation admins and owners can do this.",
	}),
	"organisation.billing_canceled": msg({
		id: "error.organisation.billing_canceled",
		message:
			"Your organisation's plan is canceled. Reactivate it to add workspaces.",
	}),
	"organisation.billing_role_only": msg({
		id: "error.organisation.billing_role_only",
		message:
			"Only organisation admins, owners and billing members can see this.",
	}),
	"organisation.deleted": msg({
		id: "error.organisation.deleted",
		message: "This organisation no longer exists.",
	}),
	"organisation.external_cannot_manage": msg({
		id: "error.organisation.external_cannot_manage",
		message:
			"This person is an external on one of your workspaces. Remove that role first, then make them an admin or owner.",
	}),
	"organisation.name_required": msg({
		id: "error.organisation.name_required",
		message: "Give your organisation a name.",
	}),
	"organisation.no_access": msg({
		id: "error.organisation.no_access",
		message: "You are not a member of this organisation.",
	}),
	"organisation.no_billing_account": msg({
		id: "error.organisation.no_billing_account",
		message:
			"Your organisation has no billing set up, so you cannot add a workspace yet. Contact support and we will sort it out.",
	}),
	"organisation.not_found": msg({
		id: "error.organisation.not_found",
		message: "We could not find this organisation.",
	}),
	"organisation.not_member": msg({
		id: "error.organisation.not_member",
		message: "You are not a member of this organisation.",
	}),
	"organisation.owner_only": msg({
		id: "error.organisation.owner_only",
		message: "Only an organisation owner can do this.",
	}),
} satisfies Messages<"organisation">;
