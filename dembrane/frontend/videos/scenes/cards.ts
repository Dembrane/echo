import { cardScene } from "./card-scene.ts";

export const welcome = cardScene({
	about: "Opening title",
	card: {
		en: {
			headline: "Welcome to dembrane",
			kind: "title",
			sub: "Record conversations, read what was said, and trace every insight back to the people who said it.",
		},
		nl: {
			headline: "Welkom bij dembrane",
			kind: "title",
			sub: "Neem gesprekken op, lees wat er gezegd is en herleid elk inzicht naar de mensen die het zeiden.",
		},
	},
	id: "welcome",
	say: [
		{
			en: "dembrane helps you listen to many conversations at once, and keep every voice traceable.",
			nl: "dembrane helpt je om naar veel gesprekken tegelijk te luisteren, en elke stem herleidbaar te houden.",
		},
	],
	since: "v2.0.0",
});

// Stands in until the best practices project ships (thread "Best practices starter
// project"); then this becomes an app scene that opens it and asks it a question.
export const bestPractices = cardScene({
	about: "Placeholder: the best practices project every new user is added to",
	card: {
		en: {
			headline: "Start in the best practices project",
			kicker: "Placeholder scene",
			kind: "title",
			sub: "Ask it how other organisations use dembrane, before you plan your own.",
		},
		nl: {
			headline: "Begin in het project met goede voorbeelden",
			kicker: "Tijdelijke scène",
			kind: "title",
			sub: "Vraag hoe andere organisaties dembrane gebruiken, voordat je je eigen traject plant.",
		},
	},
	id: "best-practices",
	say: [
		{
			en: "Your account comes with a best practices project. Ask it how other organisations use dembrane.",
			nl: "Je account heeft een project met goede voorbeelden. Vraag het hoe andere organisaties dembrane gebruiken.",
		},
	],
	since: "v3.0.0",
});

export const nextSteps = cardScene({
	about: "Closing card",
	card: {
		en: {
			headline: "Start your first project",
			kind: "points",
			points: [
				"Create a project and write down your question",
				"Share the QR code with participants",
				"Read, ask and report",
				"Help and guides: docs.dembrane.com",
			],
		},
		nl: {
			headline: "Begin je eerste project",
			kind: "points",
			points: [
				"Maak een project en schrijf je vraag op",
				"Deel de QR-code met deelnemers",
				"Lees, vraag en rapporteer",
				"Hulp en handleidingen: docs.dembrane.com",
			],
		},
	},
	id: "next-steps",
	say: [
		{
			en: "That's the whole loop. Create a project, invite people to talk, and see what they said.",
			nl: "Dat is de hele cyclus. Maak een project, nodig mensen uit om te praten en kijk wat ze zeiden.",
		},
		{
			en: "Help and guides are at docs.dembrane.com.",
			nl: "Hulp en handleidingen vind je op docs.dembrane.com.",
		},
	],
	since: "v2.0.0",
});
