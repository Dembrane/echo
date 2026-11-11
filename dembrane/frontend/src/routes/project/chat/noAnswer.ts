/** The reply stream's code for a model that answered with no text (a safety stop, say). */
export const isNoAnswer = (error: Error | undefined) =>
	error?.message === "chat.no_answer";
