import { authentication, createDirectus, rest } from "@directus/sdk";
import type { I18n } from "@lingui/core";
import { DIRECTUS_CONTENT_PUBLIC_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import type { CustomDirectusTypes as CustomDirectusTypesContent } from "./typesDirectusContent";

export const directus = createDirectus<CustomDirectusTypes>(DIRECTUS_PUBLIC_URL)
	.with(
		authentication("session", { autoRefresh: true, credentials: "include" }),
	)
	.with(
		rest({
			credentials: "include",
		}),
	);

export const directusParticipant = createDirectus<CustomDirectusTypes>(
	DIRECTUS_PUBLIC_URL,
).with(rest());

export const directusContent = createDirectus<CustomDirectusTypesContent>(
	DIRECTUS_CONTENT_PUBLIC_URL,
).with(rest());

// @TODO: this is not used as much? maybe an opportunity to standardize error handling?
// @TODO: localization
// biome-ignore lint/suspicious/noExplicitAny: needs to be fixed
export const getDirectusErrorString = (error: any, i18n?: I18n) => {
	if (error.errors && error.errors.length > 0) {
		return error.errors[0].message;
	}

	if (error.response?.status === 401) {
		return i18n
			? i18n._("You are not authenticated")
			: "You are not authenticated";
	}

	if (error.response?.status === 403) {
		return i18n
			? i18n._(`You don't have permission to access this.`)
			: "You don't have permission to access this.";
	}

	if (error.response?.status === 404) {
		return i18n ? i18n._("Resource not found") : "Resource not found";
	}

	if (error.response?.status === 500) {
		return i18n ? i18n._("Server error") : "Server error";
	}

	return i18n ? i18n._("Something went wrong") : "Something went wrong";
};
