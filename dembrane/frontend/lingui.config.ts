import type { LinguiConfig } from "@lingui/conf";

const config: LinguiConfig = {
	catalogs: [
		{
			// Everything except the accounts screens and the error messages; bundled into
			// every first load.
			exclude: [
				"<rootDir>/src/features/accounts/**",
				"<rootDir>/src/lib/errors/messages/**",
				"<rootDir>/src/components/project/templates/**",
				"<rootDir>/src/components/project/digest/**",
				"<rootDir>/src/components/project/portal-editor/**",
				"<rootDir>/src/components/project/brief/**",
				"<rootDir>/src/components/project/advanced/**",
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
			// The template picker's own catalog (ECHO-1053): sixteen templates' names, lines
			// and facts, loaded when the picker opens (src/components/project/templates/i18n.ts).
			include: ["<rootDir>/src/components/project/templates"],
			path: "<rootDir>/src/components/project/templates/locales/{locale}",
		},
		{
			// The context digest's own catalog (ECHO-1055): the drop zone, the review and its
			// messages, loaded when the drop zone first shows (src/components/project/digest/i18n.ts).
			include: ["<rootDir>/src/components/project/digest"],
			path: "<rootDir>/src/components/project/digest/locales/{locale}",
		},
		{
			// The project settings screens' own catalog (ECHO-1060): the portal editor's pages
			// and preview, Brief and Manage's Advanced tab, loaded when one of them opens
			// (src/components/project/portal-editor/i18n.ts).
			include: [
				"<rootDir>/src/components/project/portal-editor",
				"<rootDir>/src/components/project/brief",
				"<rootDir>/src/components/project/advanced",
			],
			path: "<rootDir>/src/components/project/portal-editor/locales/{locale}",
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
