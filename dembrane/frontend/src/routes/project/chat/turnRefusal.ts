import { freeLimitDetails, isFreeTierLimitError } from "@/lib/freeTier";

/** A free-limit 402 on a chat turn, from useChat's error (its message is the body). */
export const turnRefusalOf = (error: Error | undefined) => {
	try {
		const body: unknown = JSON.parse(error?.message ?? "");
		const limit = isFreeTierLimitError(body);
		if (limit !== "chat_turns" && limit !== "chats") return null;
		return {
			frozen: freeLimitDetails(body)?.reason === "frozen",
			monthly: limit === "chats",
		};
	} catch {
		return null;
	}
};
