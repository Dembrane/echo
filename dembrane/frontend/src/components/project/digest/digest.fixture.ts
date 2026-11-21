import type { DigestResult } from "./digest";

/**
 * What the digest returns for a fictional resident evening (an invitation PDF, an agenda
 * .docx and a slides .pptx), in Dutch and English, for the block tests and the harness.
 * Every name in it is invented.
 */
export const DIGEST_RESULT_NL: DigestResult = {
	context:
		"Bewonersavond over de herinrichting van de Kanaalzone-Oost, georganiseerd door gemeente Veldhoven-Noord en woningcorporatie Thuisbasis. Donderdag 4 december, 19.30 tot 21.30 uur in Wijkcentrum De Schakel. Bewoners praten aan tafels in twee rondes: wat gaat goed in de buurt, en wat moet anders aan de nieuwe groenstrook langs de Sluisweg. Wethouder Ramon Dijkhuis opent, projectleider Saskia Holtrop sluit af met het vervolg.",
	explore_prompt:
		"Stel de groep één open vraag die helpt om te bespreken wat goed gaat in de Kanaalzone-Oost en wat anders moet aan de groenstrook langs de Sluisweg. Geef nooit zelf een mening, advies of feiten.",
	goal: "Horen wat bewoners waarderen in de Kanaalzone-Oost en wat zij anders willen aan de groenstrook langs de Sluisweg.",
	host_script_additions: [
		"Begin ronde 1 met de vraag wat goed gaat in de buurt, en laat iedereen kort aan het woord.",
		"Noem in ronde 2 de Sluisweg en de groenstrook, en vraag naar concrete plekken.",
	],
	key_terms: [
		{
			reason: "De buurt waar de avond over gaat.",
			snippet: "Uitnodiging bewonersavond Kanaalzone-Oost",
			source: "uitnodiging-bewonersavond.pdf",
			term: "Kanaalzone-Oost",
		},
		{
			reason: "De woningcorporatie die meedoet.",
			snippet:
				"Gemeente Veldhoven-Noord en woningcorporatie Thuisbasis nodigen je uit voor een bewonersavond",
			source: "uitnodiging-bewonersavond.pdf",
			term: "Thuisbasis",
		},
		{
			reason: "De straat langs de groenstrook.",
			snippet: "Ronde 2: Wat moet anders aan de groenstrook langs de Sluisweg?",
			source: "agenda.docx",
			term: "Sluisweg",
		},
		{
			reason: "De locatie.",
			snippet: "Locatie: Wijkcentrum De Schakel, Sluisweg 12",
			source: "uitnodiging-bewonersavond.pdf",
			term: "Wijkcentrum De Schakel",
		},
		{
			reason: "De wethouder die opent.",
			snippet: "19.30 Welkom door wethouder Ramon Dijkhuis",
			source: "agenda.docx",
			term: "Ramon Dijkhuis",
		},
	],
	max_key_terms: 30,
	name: "Bewonersavond Kanaalzone-Oost",
	name_label: "Tafel",
	notes: ["personal_data_removed"],
	provenance: {
		context: {
			snippet:
				"Samen met jou willen we weten wat goed gaat in de buurt en wat er anders moet aan de nieuwe groenstrook langs de Sluisweg.",
			source: "uitnodiging-bewonersavond.pdf",
		},
		explore_prompt: {
			snippet: "Ronde 1: Wat gaat goed in de Kanaalzone-Oost?",
			source: "agenda.docx",
		},
		goal: {
			snippet:
				"Samen met jou willen we weten wat goed gaat in de buurt en wat er anders moet aan de nieuwe groenstrook langs de Sluisweg.",
			source: "uitnodiging-bewonersavond.pdf",
		},
		name: {
			snippet: "Uitnodiging bewonersavond Kanaalzone-Oost",
			source: "uitnodiging-bewonersavond.pdf",
		},
		tags: {
			snippet: "19.45 Ronde 1: Wat gaat goed in de Kanaalzone-Oost?",
			source: "agenda.docx",
		},
		template_key: {
			snippet: "Bewoners praten aan tafels in twee rondes",
			source: "programma.pptx",
		},
	},
	sources: [
		{
			chars: 569,
			condensed: false,
			kind: "file",
			name: "uitnodiging-bewonersavond.pdf",
		},
		{ chars: 318, condensed: false, kind: "file", name: "agenda.docx" },
		{ chars: 240, condensed: false, kind: "file", name: "programma.pptx" },
	],
	tags: ["Ronde 1: wat gaat goed", "Ronde 2: de groenstrook"],
	template: {
		key: "resident_evening",
		reason:
			"Bewoners praten in rondes aan tafels, elke tafel met een eigen telefoon.",
		runner_ups: ["world_cafe", "citizens_assembly"],
	},
	verify_topics: ["agreements"],
};

export const DIGEST_RESULT_EN: DigestResult = {
	...DIGEST_RESULT_NL,
	context:
		"Resident evening on redesigning the Kanaalzone-Oost, run by the municipality of Veldhoven-Noord and housing association Thuisbasis. Thursday 4 December, 19.30 to 21.30 at Wijkcentrum De Schakel. Residents talk at tables in two rounds: what works in the neighbourhood, and what should change about the new green strip along the Sluisweg. Alderman Ramon Dijkhuis opens; project lead Saskia Holtrop closes with next steps.",
	explore_prompt:
		"Ask the group one open question that helps them discuss what works in the Kanaalzone-Oost and what should change about the green strip along the Sluisweg. Never give your own opinion, advice or facts.",
	goal: "Hear what residents value in the Kanaalzone-Oost and what they want changed about the green strip along the Sluisweg.",
	host_script_additions: [
		"Open round 1 by asking what works in the neighbourhood, and give everyone a short turn.",
		"In round 2, name the Sluisweg and the green strip, and ask about specific places.",
	],
	key_terms: DIGEST_RESULT_NL.key_terms.map((k, i) => ({
		...k,
		reason: [
			"The neighbourhood the evening is about.",
			"The housing association taking part.",
			"The street along the green strip.",
			"The venue.",
			"The alderman who opens.",
		][i] as string,
	})),
	name: "Resident evening Kanaalzone-Oost",
	name_label: "Tafel",
	template: {
		key: "resident_evening",
		reason:
			"Residents talk at tables in rounds, each table with its own phone.",
		runner_ups: ["world_cafe", "citizens_assembly"],
	},
};
