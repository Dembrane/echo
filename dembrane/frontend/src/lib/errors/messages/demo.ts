import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

// Staff codes; these two are what publishing with the email on answers when the
// organisation or the contact changed since the demo was built, read on the demo's page.
export const demo = {
	"demo.contact_not_in_organisation": msg({
		id: "error.demo.contact_not_in_organisation",
		message:
			"They are no longer in this organisation, so the demo was not published. Add them back, or publish with the email off.",
	}),
	"demo.organisation_deleted": msg({
		id: "error.demo.organisation_deleted",
		message:
			"The organisation for this demo was deleted, so nothing was done. Restore it and try again, or publish with the email off.",
	}),
} satisfies Messages<"demo">;
