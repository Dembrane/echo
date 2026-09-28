import type { I18n } from "@lingui/core";
import { toast } from "@/components/common/Toaster";
import { presentError } from "./present";

/**
 * A toast for one recipient of a batch (invites, shares) that failed: the address, then
 * the presented message, so a batch of five says which one went wrong.
 */
export function toastForEmail(email: string, error: unknown, i18n: I18n): void {
	void presentError(error, i18n).then((presented) =>
		toast.error(`${email}: ${presented.message}`),
	);
}
