import type { LinguiConfig } from "@lingui/conf";

const config: LinguiConfig = {
	catalogs: [
		{
			// Everything except the accounts screens; bundled into every first load.
			exclude: ["<rootDir>/src/features/accounts/**"],
			include: ["src"],
			path: "<rootDir>/src/locales/{locale}",
		},
		{
			// The accounts screens' own catalog, loaded when one of them opens
			// (src/features/accounts/i18n.tsx), so their strings never weigh on the
			// participant portal's first load.
			include: ["<rootDir>/src/features/accounts"],
			path: "<rootDir>/src/features/accounts/locales/{locale}",
		},
	],
	fallbackLocales: {
		default: "en-US",
	},
	locales: [
		"en-US",
		"nl-NL",
		"de-DE",
		"fr-FR",
		"es-ES",
		"it-IT",
		"uk-UA",
		"cs-CZ",
	],
	sourceLocale: "en-US",
};

export default config;
