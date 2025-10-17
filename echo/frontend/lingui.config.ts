import type { LinguiConfig } from "@lingui/conf";

const config: LinguiConfig = {
	catalogs: [
		{
			include: ["src"],
			path: "<rootDir>/src/locales/{locale}",
		},
	],
	fallbackLocales: {
		default: "en-US",
	},
	locales: ["en-US", "nl-NL", "de-DE", "fr-FR", "es-ES"],
	sourceLocale: "en-US",
};

export default config;
