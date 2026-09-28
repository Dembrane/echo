import type { I18n } from "@lingui/core";

/**
 * One generic sentence for a failed API request, by the HTTP status an axios error
 * carries. Errors without a response read "Something went wrong".
 */
export const getApiErrorString = (error: unknown, i18n?: I18n): string => {
	const say = (text: string) => (i18n ? i18n._(text) : text);
	const status = (error as { response?: { status?: number } } | null)?.response
		?.status;
	if (status === 401) return say("You are not authenticated");
	if (status === 403) return say(`You don't have permission to access this.`);
	if (status === 404) return say("Resource not found");
	if (status === 500) return say("Server error");
	return say("Something went wrong");
};
