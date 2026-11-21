import type { SetupSuggestions } from "./setupSuggestions";

/** A realistic answer for a Dutch residents' evening started from the "conversation" template, for tests and the screenshot harness. */
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
	// Proposals on top of the "conversation" template, which asks no name and has Verify
	// off: both are real changes there.
	settings: [
		{
			current: false,
			field: "default_conversation_ask_for_participant_name",
			proposed: true,
			reason: "Twaalf tafels nemen op; zo weet je welke tafel wat zei.",
		},
		{
			current: false,
			field: "is_verify_enabled",
			proposed: true,
			reason: "Je wilt dat iedere tafel de afspraken bevestigt.",
		},
	],
};
