import { aiBudgetDetails, isFreeTierLimitError } from "@/lib/freeTier";

// useChat's error carries the response body as its message.
const bodyOf = (error: Error | undefined): unknown => {
	try {
		return JSON.parse(error?.message ?? "");
	} catch {
		return null;
	}
};

/** True when a sample project's chat turn was refused (402 chat_turns). */
export const turnRefusalOf = (error: Error | undefined): boolean =>
	isFreeTierLimitError(bodyOf(error)) === "chat_turns";

/** The used-up AI budget behind a refused reply, or null. */
export const aiBudgetRefusalOf = (error: Error | undefined) =>
	aiBudgetDetails(bodyOf(error));
