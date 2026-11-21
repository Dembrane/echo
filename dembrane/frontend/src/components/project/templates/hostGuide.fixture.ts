// Test data: project.host_guide as the platform writes it for the resident evening template
// (ECHO-1053; platform templateHostGuide), in English and Dutch.
export const RESIDENT_EVENING_GUIDE = {
	en: {
		language: "en",
		steps: [
			{
				content: "Type your table name and tap the tag for this round.",
				highlights: [],
			},
			{
				content:
					"Do introductions first, then press Record. You can pause at any time.",
				highlights: [],
			},
			{
				content:
					"Stuck, or one voice taking over? Press ECHO, then Explore, and read the question aloud.",
				highlights: ["ECHO", "Explore"],
			},
			{
				content:
					"Ten minutes before the end, press ECHO, then Verify, and read the draft aloud.",
				highlights: ["ECHO", "Verify"],
			},
			{
				content:
					"Ask: does this say what most of us think, or what one of us thinks?",
				highlights: [],
			},
			{
				content:
					"Say what to change and press Revise. When it is right, press Approve, then Stop and Finish.",
				highlights: ["Revise", "Approve"],
			},
		],
		tips: [
			{
				content: "Let everyone speak once before anyone speaks twice.",
				highlights: [],
			},
			{
				content:
					"Put the phone in the middle of the table and keep the screen on.",
				highlights: [],
			},
			{
				content: "Need a break? Press Stop, then Resume.",
				highlights: [],
			},
		],
		title: "Hosting a table at a resident evening",
	},
	nl: {
		language: "nl",
		steps: [
			{
				content: "Typ de naam van je tafel en tik op de tag van deze ronde.",
				highlights: [],
			},
			{
				content:
					"Doe eerst een voorstelrondje en druk dan op Opname starten. Je kunt altijd even pauzeren.",
				highlights: ["Opname starten"],
			},
			{
				content:
					"Loopt het vast, of hoor je steeds dezelfde stem? Druk op ECHO, dan op Verkennen, en lees de vraag hardop voor.",
				highlights: ["ECHO", "Verkennen"],
			},
			{
				content:
					"Tien minuten voor het einde: druk op ECHO, dan op Verifiëren, en lees het concept hardop voor.",
				highlights: ["ECHO", "Verifiëren"],
			},
			{
				content:
					"Vraag: staat hier wat de meesten van ons denken, of wat één van ons denkt?",
				highlights: [],
			},
			{
				content:
					"Zeg wat er anders moet en druk op Aanpassen. Klopt het? Druk op Goedkeuren, dan op Stop en Afronden.",
				highlights: ["Aanpassen", "Goedkeuren", "Afronden", "Stop"],
			},
		],
		tips: [
			{
				content:
					"Laat iedereen één keer aan het woord voordat iemand voor de tweede keer praat.",
				highlights: [],
			},
			{
				content: "Leg de telefoon midden op tafel en laat het scherm aan.",
				highlights: [],
			},
			{
				content: "Even pauze? Druk op Stop en daarna op Hervatten.",
				highlights: ["Hervatten", "Stop"],
			},
		],
		title: "Een tafel leiden op de bewonersavond",
	},
};
