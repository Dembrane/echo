import type { LinguiConfig } from "@lingui/conf";

const config: LinguiConfig = {
	catalogs: [
		{
			// Everything except the accounts screens and the error messages; bundled into
			// every first load.
			exclude: [
				"<rootDir>/src/features/accounts/**",
				"<rootDir>/src/lib/errors/messages/**",
			],
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
		{
			// The friendly message for every error code, loaded with the first error a
			// screen shows (src/lib/errors/present.ts), never in the first load.
			include: ["<rootDir>/src/lib/errors/messages"],
			path: "<rootDir>/src/lib/errors/locales/{locale}",
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
