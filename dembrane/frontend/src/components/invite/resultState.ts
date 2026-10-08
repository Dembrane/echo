import type { InviteResultState } from "./InviteResultsList";

// The row state for an invite call that succeeded, from the server's status.
export function resultStateFor(status: string | undefined): InviteResultState {
	if (status === "added" || status === "reactivated") return "added";
	if (status === "already_member") return "already_member";
	if (status === "already_invited") return "already_invited";
	return "sent";
}
