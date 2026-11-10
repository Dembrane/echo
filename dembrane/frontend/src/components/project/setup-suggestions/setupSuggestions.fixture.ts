import type { SetupSuggestions } from "./setupSuggestions";

/** A realistic answer for a Dutch residents' evening, for tests and the screenshot harness. */
export const SUGGESTIONS: SetupSuggestions = {
	key_terms: [
		{
			reason: "De wethouder die de avond opent.",
			source: "text",
			term: "Marieke de Wolf",
		},
		{
			reason: "De wijk waar het over gaat.",
			source: "description",
			term: "Strijp-S",
		},
		{
			reason: "De woningcorporatie aan tafel.",
			source: "text",
			term: "Woonbedrijf",
		},
		{
			reason: "Leverancier van het warmtenet.",
			source: "text",
			term: "Ennatuurlijk",
		},
		{
			reason: "Vereniging van eigenaren.",
			source: "url",
			term: "VvE Strijp-R",
		},
	],
	max_key_terms: 30,
	notes: [],
	settings: [
		{
			current: false,
			field: "is_verify_enabled",
			proposed: true,
			reason: "Je wilt dat iedere tafel de afspraken bevestigt.",
		},
		{
			current: "None",
			field: "default_conversation_tutorial_slug",
			proposed: "advanced",
			reason: "Twaalf tafels nemen tegelijk op met hun telefoon.",
		},
	],
};
