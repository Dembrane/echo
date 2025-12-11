import {
	HelpCircle,
	Lock,
	MessagesSquare,
	Orbit,
	PartyPopper,
	Server,
	Smartphone,
	Speech,
	Volume2,
	Wifi,
} from "lucide-react";
import type { LanguageCards } from "../ParticipantOnboardingCards";

export const useOnboardingCards = () => {
	const getSystemCards = (
		lang: string,
		tutorialSlug?: string,
	): LanguageCards[string] => {
		// Normalize and fallback invalid values to "none"
		const normalizedSlug = tutorialSlug?.toLowerCase();
		const validSlugs = ["skip-consent", "none", "basic", "advanced"];
		const finalSlug = validSlugs.includes(normalizedSlug || "")
			? normalizedSlug
			: "none";

		if (finalSlug === "skip-consent") {
			return [];
		}

		// none: Only privacy statement
		if (finalSlug === "none") {
			const privacyCard = getPrivacyCard(lang);
			return privacyCard ? [privacyCard] : [];
		}

		// basic: Tutorial slides + privacy statement
		if (finalSlug === "basic") {
			const tutorialCards = getBasicTutorialCards(lang);
			const privacyCard = getPrivacyCard(lang);
			return [...tutorialCards, ...(privacyCard ? [privacyCard] : [])];
		}

		// advanced: Full tutorial + privacy statement + best practices
		if (finalSlug === "advanced") {
			const tutorialCards = getAdvancedTutorialCards(lang);
			return tutorialCards;
		}

		return [];
	};

	const getBasicTutorialCards = (lang: string): LanguageCards[string] => {
		const tutorialCards: Record<string, LanguageCards[string]> = {
			"de-DE": [
				{
					section: "Willkommen",
					slides: [
						{
							content:
								"Nehmen Sie Ihre Stimme auf, um Fragen zu beantworten und Einfluss zu nehmen.",
							cta: "Los geht's!",
							extraHelp:
								"Dies ist ein Mini-Tutorial. Nutzen Sie die Vor- und Zurück-Tasten zur Navigation. Nach Abschluss gelangen Sie zum Aufnahmeportal.",
							icon: PartyPopper,
							title: "Willkommen bei Dembrane!",
						},
						{
							content:
								"Dembrane hilft Menschen, einfach Input von großen Gruppen zu sammeln.",
							cta: "Mehr erfahren",
							extraHelp:
								"Ob Feedback für eine Kommune, Input im Arbeitsumfeld oder Teilnahme an Forschung – Ihre Stimme zählt!",
							icon: Orbit,
							title: "Was ist Dembrane?",
						},
						{
							content:
								"Beantworten Sie Fragen in Ihrem eigenen Tempo durch Sprechen oder Tippen.",
							cta: "Weiter",
							extraHelp:
								"Spracheingabe ist unser bevorzugter Modus, da sie natürlichere und detailliertere Antworten ermöglicht. Tippen steht immer als Alternative zur Verfügung.",
							icon: Speech,
							title: "Sagen Sie einfach Ihre Meinung",
						},
						{
							content: "Dembrane macht in Gruppen mehr Spaß!",
							cta: "Weiter",
							extraHelp:
								"Dembrane macht mehr Spaß, wenn Sie jemanden finden, um die Fragen gemeinsam zu besprechen und Ihr Gespräch aufzunehmen. Wir können nicht sagen, wer was gesagt hat, nur welche Ideen geteilt wurden.",
							icon: MessagesSquare,
							title: "Allein oder in der Gruppe",
						},
					],
				},
				{
					section: "Wie es funktioniert",
					slides: [
						{
							content:
								"Sie erhalten die Fragen, sobald Sie im Aufnahmeportal sind.",
							cta: "Verstanden",
							extraHelp:
								"Die Fragen variieren je nach den Bedürfnissen des Gastgebers. Sie können sich auf kommunale Themen, Arbeitserfahrungen oder Forschungsthemen beziehen. Wenn es keine spezifischen Fragen gibt, können Sie gerne alle Gedanken oder Anliegen teilen.",
							icon: HelpCircle,
							title: "Fragerunde",
						},
					],
				},
				{
					section: "Datenschutz",
					slides: [
						{
							content:
								"Als Aufnehmer haben Sie die Kontrolle über das, was Sie teilen.",
							cta: "Mehr erfahren",
							extraHelp:
								"Vermeiden Sie die Weitergabe von Details, die Sie dem Gastgeber nicht mitteilen möchten. Seien Sie achtsam und nehmen Sie andere nicht ohne deren Zustimmung auf.",
							icon: Lock,
							title: "Datenschutz ist wichtig",
						},
					],
				},
			],
			"en-US": [
				{
					section: "Welcome",
					slides: [
						{
							content:
								"Record your voice to answer questions and make an impact.",
							cta: "Let's go!",
							extraHelp:
								"This is a mini-tutorial. Use the previous and next buttons to navigate. Once completed, you'll enter the recording portal.",
							icon: PartyPopper,
							title: "Welcome to Dembrane!",
						},
						{
							content:
								"Dembrane helps people gather input from large groups easily.",
							cta: "Tell me more",
							extraHelp:
								"Whether it's feedback for a local municipality, input in a work setting, or participation in research, your voice matters!",
							icon: Orbit,
							title: "What is Dembrane?",
						},
						{
							content:
								"Answer questions in your own time by speaking or typing.",
							cta: "Next",
							extraHelp:
								"Voice input is our primary mode, allowing for more natural and detailed responses. Typing is always available as a backup.",
							icon: Speech,
							title: "Just Speak Your Mind",
						},
						{
							content: "Dembrane is more fun in groups!",
							cta: "Next",
							extraHelp:
								"Dembrane is more fun when you find someone to discuss the questions together and record your conversation. We can't tell who said what, just what ideas were shared.",
							icon: MessagesSquare,
							title: "Solo or in a Group",
						},
					],
				},
				{
					section: "How it works",
					slides: [
						{
							content:
								"You'll receive the questions once in the recording portal.",
							cta: "Got it",
							extraHelp:
								"Questions vary based on the host's needs. They could be about community issues, work experiences, or research topics. If there are no specific questions, you're free to share any thoughts or concerns.",
							icon: HelpCircle,
							title: "Question Time",
						},
					],
				},
				{
					section: "Privacy",
					slides: [
						{
							content: "As the recorder, you are in control of what you share.",
							cta: "Tell me more",
							extraHelp:
								"Avoid sharing details you don't want the host to know. Be mindful and don't record others without their consent.",
							icon: Lock,
							title: "Privacy Matters",
						},
					],
				},
			],
			"es-ES": [
				{
					section: "Bienvenido",
					slides: [
						{
							content:
								"Graba tu voz para responder preguntas y generar impacto.",
							cta: "¡Vamos!",
							extraHelp:
								"Este es un mini-tutorial. Usa los botones de anterior y siguiente para navegar. Una vez completado, entrarás al portal de grabación.",
							icon: PartyPopper,
							title: "¡Bienvenido a Dembrane!",
						},
						{
							content:
								"Dembrane ayuda a las personas a recopilar aportaciones de grandes grupos fácilmente.",
							cta: "Cuéntame más",
							extraHelp:
								"Ya sea retroalimentación para una municipalidad local, aportaciones en el trabajo o participación en investigación, ¡tu voz importa!",
							icon: Orbit,
							title: "¿Qué es Dembrane?",
						},
						{
							content:
								"Responde preguntas a tu propio ritmo hablando o escribiendo.",
							cta: "Siguiente",
							extraHelp:
								"La entrada de voz es nuestro modo principal, permitiendo respuestas más naturales y detalladas. Escribir siempre está disponible como respaldo.",
							icon: Speech,
							title: "Solo Di Lo Que Piensas",
						},
						{
							content: "¡Dembrane es más divertido en grupos!",
							cta: "Siguiente",
							extraHelp:
								"Dembrane es más divertido cuando encuentras a alguien para discutir las preguntas juntos y grabar su conversación. No podemos distinguir quién dijo qué, solo qué ideas se compartieron.",
							icon: MessagesSquare,
							title: "Solo o en Grupo",
						},
					],
				},
				{
					section: "Cómo funciona",
					slides: [
						{
							content:
								"Recibirás las preguntas una vez en el portal de grabación.",
							cta: "Entendido",
							extraHelp:
								"Las preguntas varían según las necesidades del anfitrión. Pueden ser sobre temas comunitarios, experiencias laborales o temas de investigación. Si no hay preguntas específicas, eres libre de compartir cualquier pensamiento o inquietud.",
							icon: HelpCircle,
							title: "Hora de Preguntas",
						},
					],
				},
				{
					section: "Privacidad",
					slides: [
						{
							content: "Como grabador, tú controlas lo que compartes.",
							cta: "Cuéntame más",
							extraHelp:
								"Evita compartir detalles que no quieras que el anfitrión conozca. Sé consciente y no grabes a otros sin su consentimiento.",
							icon: Lock,
							title: "La Privacidad Importa",
						},
					],
				},
			],
			"fr-FR": [
				{
					section: "Bienvenue",
					slides: [
						{
							content:
								"Enregistrez votre voix pour répondre aux questions et avoir un impact.",
							cta: "C'est parti !",
							extraHelp:
								"Ceci est un mini-tutoriel. Utilisez les boutons précédent et suivant pour naviguer. Une fois terminé, vous entrerez dans le portail d'enregistrement.",
							icon: PartyPopper,
							title: "Bienvenue sur Dembrane !",
						},
						{
							content:
								"Dembrane aide les gens à recueillir facilement les contributions de grands groupes.",
							cta: "Dites-m'en plus",
							extraHelp:
								"Qu'il s'agisse de commentaires pour une municipalité locale, de contributions dans un cadre professionnel ou de participation à une recherche, votre voix compte !",
							icon: Orbit,
							title: "Qu'est-ce que Dembrane ?",
						},
						{
							content:
								"Répondez aux questions à votre rythme en parlant ou en tapant.",
							cta: "Suivant",
							extraHelp:
								"La saisie vocale est notre mode principal, permettant des réponses plus naturelles et détaillées. La saisie au clavier est toujours disponible en secours.",
							icon: Speech,
							title: "Dites Simplement Ce Que Vous Pensez",
						},
						{
							content: "Dembrane est plus amusant en groupe !",
							cta: "Suivant",
							extraHelp:
								"Dembrane est plus amusant lorsque vous trouvez quelqu'un pour discuter des questions ensemble et enregistrer votre conversation. Nous ne pouvons pas dire qui a dit quoi, juste quelles idées ont été partagées.",
							icon: MessagesSquare,
							title: "Seul ou en Groupe",
						},
					],
				},
				{
					section: "Comment ça marche",
					slides: [
						{
							content:
								"Vous recevrez les questions une fois dans le portail d'enregistrement.",
							cta: "Compris",
							extraHelp:
								"Les questions varient en fonction des besoins de l'hôte. Elles peuvent concerner des problèmes communautaires, des expériences professionnelles ou des sujets de recherche. S'il n'y a pas de questions spécifiques, vous êtes libre de partager vos pensées ou préoccupations.",
							icon: HelpCircle,
							title: "Heure des Questions",
						},
					],
				},
				{
					section: "Confidentialité",
					slides: [
						{
							content:
								"En tant qu'enregistreur, vous contrôlez ce que vous partagez.",
							cta: "Dites-m'en plus",
							extraHelp:
								"Évitez de partager des détails que vous ne voulez pas que l'hôte connaisse. Soyez attentif et n'enregistrez pas les autres sans leur consentement.",
							icon: Lock,
							title: "La Confidentialité Compte",
						},
					],
				},
			],
			"it-IT": [
				{
					section: "Benvenuto",
					slides: [
						{
							content:
								"Registra la tua voce per rispondere alle domande e avere un impatto.",
							cta: "Andiamo!",
							extraHelp:
								"Questo è un mini-tutorial. Usa i pulsanti precedente e successivo per navigare. Al termine entrerai nel portale di registrazione.",
							icon: PartyPopper,
							title: "Benvenuto su Dembrane!",
						},
						{
							content:
								"Dembrane aiuta a raccogliere facilmente contributi da grandi gruppi.",
							cta: "Dimmi di più",
							extraHelp:
								"Che si tratti di feedback per un comune, di input sul lavoro o di partecipazione a una ricerca, la tua voce conta!",
							icon: Orbit,
							title: "Cos'è Dembrane?",
						},
						{
							content:
								"Rispondi alle domande a tuo ritmo parlando o scrivendo.",
							cta: "Avanti",
							extraHelp:
								"La voce è la modalità principale perché permette risposte più naturali e ricche. Scrivere è sempre disponibile come alternativa.",
							icon: Speech,
							title: "Dì semplicemente ciò che pensi",
						},
						{
							content: "Dembrane è più divertente in gruppo!",
							cta: "Avanti",
							extraHelp:
								"È ancora meglio se trovi qualcuno con cui discutere le domande e registrare la conversazione. Non possiamo sapere chi ha detto cosa, solo quali idee sono state condivise.",
							icon: MessagesSquare,
							title: "Da soli o in gruppo",
						},
					],
				},
				{
					section: "Come funziona",
					slides: [
						{
							content:
								"Riceverai le domande quando sarai nel portale di registrazione.",
							cta: "Capito",
							extraHelp:
								"Le domande variano in base alle esigenze dell'host. Possono riguardare temi della comunità, esperienze di lavoro o ricerca. Se non ci sono domande specifiche, puoi condividere qualsiasi pensiero o preoccupazione.",
							icon: HelpCircle,
							title: "È il momento delle domande",
						},
					],
				},
				{
					section: "Privacy",
					slides: [
						{
							content: "Come registratore, controlli tu ciò che condividi.",
							cta: "Dimmi di più",
							extraHelp:
								"Evita di condividere dettagli che non vuoi rendere noti all'host. Chiedi sempre il consenso prima di registrare altre persone.",
							icon: Lock,
							title: "La privacy conta",
						},
					],
				},
			],
			"nl-NL": [
				{
					section: "Welkom",
					slides: [
						{
							content:
								"Neem je stem op om vragen te beantwoorden en impact te maken.",
							cta: "Aan de slag!",
							extraHelp:
								"Dit is een mini-handleiding. Gebruik de knoppen om te navigeren. Na afloop van de handleiding kom je in de opnameportaal terecht.",
							icon: PartyPopper,
							title: "Welkom bij Dembrane!",
						},
						{
							content:
								"Dembrane helpt mensen gemakkelijk input van grote groepen te verzamelen.",
							cta: "Vertel me meer",
							extraHelp:
								"Of het nu gaat om feedback voor de gemeente, input op het werk, of deelname aan onderzoek, jouw stem telt!",
							icon: Orbit,
							title: "Wat is Dembrane?",
						},
						{
							content:
								"Beantwoord vragen in je eigen tempo door te spreken of te typen.",
							cta: "Volgende",
							extraHelp:
								"Spraak is onze voorkeursmethode, omdat het natuurlijker en gedetailleerder is. Typen kan natuurlijk ook altijd.",
							icon: Speech,
							title: "Zeg het maar",
						},
						{
							content: "Dembrane is leuker met een groep!",
							cta: "Volgende",
							extraHelp:
								"Dembrane is leuker als je iemand vindt om de vragen samen te bespreken en jullie gesprek op te nemen. We kunnen niet horen wie wat zei, alleen welke ideeën er gedeeld zijn.",
							icon: MessagesSquare,
							title: "Alleen of in een groep",
						},
					],
				},
				{
					section: "Hoe het werkt",
					slides: [
						{
							content:
								"Je krijgt de vragen te zien zodra je in de opnameportal bent.",
							cta: "Begrepen",
							extraHelp:
								"Vragen variëren afhankelijk van wat de organisator wil weten. Het kan gaan over de buurt, werkervaringen, of onderzoeksonderwerpen. Als er geen specifieke vragen zijn, kun je gewoon je gedachten of zorgen delen.",
							icon: HelpCircle,
							title: "Vragenronde",
						},
					],
				},
				{
					section: "Privacy",
					slides: [
						{
							content: "Als opnemer heb je zelf controle over wat je deelt.",
							cta: "Vertel me meer",
							extraHelp:
								"Vermijd het delen van details die je niet met de organisator wilt delen. Wees voorzichtig en neem anderen niet op zonder hun toestemming.",
							icon: Lock,
							title: "Privacy is belangrijk",
						},
					],
				},
			],
		};

		// Fallback to English if language not found
		return tutorialCards[lang] || tutorialCards["en-US"] || [];
	};

	const getAdvancedTutorialCards = (lang: string): LanguageCards[string] => {
		const tutorialCards: Record<string, LanguageCards[string]> = {
			"de-DE": [
				{
					section: "Willkommen",
					slides: [
						{
							content:
								"Nehmen Sie Ihre Stimme auf, um Fragen zu beantworten und Einfluss zu nehmen.",
							cta: "Los geht's!",
							extraHelp:
								"Dies ist ein Mini-Tutorial. Nutzen Sie die Vor- und Zurück-Tasten zur Navigation. Nach Abschluss gelangen Sie zum Aufnahmeportal.",
							icon: PartyPopper,
							title: "Willkommen bei Dembrane!",
						},
						{
							content:
								"Dembrane hilft Menschen, einfach Input von großen Gruppen zu sammeln.",
							cta: "Mehr erfahren",
							extraHelp:
								"Ob Feedback für eine Kommune, Input im Arbeitsumfeld oder Teilnahme an Forschung – Ihre Stimme zählt!",
							icon: Orbit,
							title: "Was ist Dembrane?",
						},
						{
							content:
								"Beantworten Sie Fragen in Ihrem eigenen Tempo durch Sprechen oder Tippen.",
							cta: "Weiter",
							extraHelp:
								"Spracheingabe ist unser bevorzugter Modus, da sie natürlichere und detailliertere Antworten ermöglicht. Tippen steht immer als Alternative zur Verfügung.",
							icon: Speech,
							title: "Sagen Sie einfach Ihre Meinung",
						},
						{
							content: "Dembrane macht in Gruppen mehr Spaß!",
							cta: "Weiter",
							extraHelp:
								"Dembrane macht mehr Spaß, wenn Sie jemanden finden, um die Fragen gemeinsam zu besprechen und Ihr Gespräch aufzunehmen. Wir können nicht sagen, wer was gesagt hat, nur welche Ideen geteilt wurden.",
							icon: MessagesSquare,
							title: "Allein oder in der Gruppe",
						},
					],
				},
				{
					section: "Wie es funktioniert",
					slides: [
						{
							content:
								"Sie erhalten die Fragen, sobald Sie im Aufnahmeportal sind.",
							cta: "Verstanden",
							extraHelp:
								"Die Fragen variieren je nach den Bedürfnissen des Gastgebers. Sie können sich auf kommunale Themen, Arbeitserfahrungen oder Forschungsthemen beziehen. Wenn es keine spezifischen Fragen gibt, können Sie gerne alle Gedanken oder Anliegen teilen.",
							icon: HelpCircle,
							title: "Fragerunde",
						},
					],
				},
				{
					section: "Datenschutz",
					slides: [
						{
							content:
								"Als Aufnehmer haben Sie die Kontrolle über das, was Sie teilen.",
							cta: "Mehr erfahren",
							extraHelp:
								"Vermeiden Sie die Weitergabe von Details, die Sie dem Gastgeber nicht mitteilen möchten. Seien Sie achtsam und nehmen Sie andere nicht ohne deren Zustimmung auf.",
							icon: Lock,
							title: "Datenschutz ist wichtig",
						},
						...(getPrivacyCard("de-DE")?.slides || []),
					],
				},
				{
					section: "Best Practices",
					slides: [
						{
							content:
								"Stellen Sie sich vor, Dembrane ist auf Lautsprecher mit Ihnen. Wenn Sie sich selbst hören können, ist alles in Ordnung.",
							cta: "Verstanden",
							extraHelp:
								"Etwas Hintergrundgeräusch ist in Ordnung, solange klar ist, wer spricht.",
							icon: Volume2,
							title: "Hintergrundgeräusche reduzieren",
						},
						{
							content:
								"Stellen Sie eine stabile Verbindung für eine reibungslose Aufnahme sicher.",
							cta: "Bereit!",
							extraHelp:
								"WLAN oder gute mobile Daten funktionieren am besten. Wenn Ihre Verbindung abbricht, keine Sorge. Sie können immer dort weitermachen, wo Sie aufgehört haben.",
							icon: Wifi,
							title: "Starke Internetverbindung",
						},
						{
							content:
								"Vermeiden Sie Unterbrechungen, indem Sie Ihr Gerät entsperrt halten. Wenn es sich sperrt, entsperren Sie es einfach und fahren Sie fort.",
							cta: "Okay",
							extraHelp:
								"Dembrane versucht, Ihr Gerät aktiv zu halten, aber manchmal können Geräte dies überschreiben. Sie können Ihre Geräteeinstellungen anpassen, um länger entsperrt zu bleiben, wenn nötig.",
							icon: Smartphone,
							title: "Gerät nicht sperren!",
						},
					],
				},
			],
			"en-US": [
				{
					section: "Welcome",
					slides: [
						{
							content:
								"Record your voice to answer questions and make an impact.",
							cta: "Let's go!",
							extraHelp:
								"This is a mini-tutorial. Use the previous and next buttons to navigate. Once completed, you'll enter the recording portal.",
							icon: PartyPopper,
							title: "Welcome to Dembrane!",
						},
						{
							content:
								"Dembrane helps people gather input from large groups easily.",
							cta: "Tell me more",
							extraHelp:
								"Whether it's feedback for a local municipality, input in a work setting, or participation in research, your voice matters!",
							icon: Orbit,
							title: "What is Dembrane?",
						},
						{
							content:
								"Answer questions in your own time by speaking or typing.",
							cta: "Next",
							extraHelp:
								"Voice input is our primary mode, allowing for more natural and detailed responses. Typing is always available as a backup.",
							icon: Speech,
							title: "Just Speak Your Mind",
						},
						{
							content: "Dembrane is more fun in groups!",
							cta: "Next",
							extraHelp:
								"Dembrane is more fun when you find someone to discuss the questions together and record your conversation. We can't tell who said what, just what ideas were shared.",
							icon: MessagesSquare,
							title: "Solo or in a Group",
						},
					],
				},
				{
					section: "How it works",
					slides: [
						{
							content:
								"You'll receive the questions once in the recording portal.",
							cta: "Got it",
							extraHelp:
								"Questions vary based on the host's needs. They could be about community issues, work experiences, or research topics. If there are no specific questions, you're free to share any thoughts or concerns.",
							icon: HelpCircle,
							title: "Question Time",
						},
					],
				},
				{
					section: "Privacy",
					slides: [
						{
							content: "As the recorder, you are in control of what you share.",
							cta: "Tell me more",
							extraHelp:
								"Avoid sharing details you don't want the host to know. Be mindful and don't record others without their consent.",
							icon: Lock,
							title: "Privacy Matters",
						},
						...(getPrivacyCard("en-US")?.slides || []),
					],
				},
				{
					section: "Best Practices",
					slides: [
						{
							content:
								"Imagine Dembrane is on speakerphone with you. If you can hear yourself, you're good to go.",
							cta: "Noted",
							extraHelp:
								"Some background noise is okay, as long as who is speaking is clear.",
							icon: Volume2,
							title: "Reduce Background Noise",
						},
						{
							content: "Ensure a stable connection for smooth recording.",
							cta: "Ready!",
							extraHelp:
								"Wi-Fi or good mobile data works best. If your connection drops, don't worry. You can always restart where you left off.",
							icon: Wifi,
							title: "Strong Internet Connection",
						},
						{
							content:
								"Prevent interruptions by keeping your device unlocked. If it locks, just unlock and continue.",
							cta: "Okay",
							extraHelp:
								"Dembrane tries to keep your device active, but sometimes devices can override it, for example if you have low power mode active. You can adjust your device settings to stay unlocked longer if needed.",
							icon: Smartphone,
							title: "Don't lock your device!",
						},
					],
				},
			],
			"es-ES": [
				{
					section: "Bienvenido",
					slides: [
						{
							content:
								"Graba tu voz para responder preguntas y generar impacto.",
							cta: "¡Vamos!",
							extraHelp:
								"Este es un mini-tutorial. Usa los botones de anterior y siguiente para navegar. Una vez completado, entrarás al portal de grabación.",
							icon: PartyPopper,
							title: "¡Bienvenido a Dembrane!",
						},
						{
							content:
								"Dembrane ayuda a las personas a recopilar aportaciones de grandes grupos fácilmente.",
							cta: "Cuéntame más",
							extraHelp:
								"Ya sea retroalimentación para una municipalidad local, aportaciones en el trabajo o participación en investigación, ¡tu voz importa!",
							icon: Orbit,
							title: "¿Qué es Dembrane?",
						},
						{
							content:
								"Responde preguntas a tu propio ritmo hablando o escribiendo.",
							cta: "Siguiente",
							extraHelp:
								"La entrada de voz es nuestro modo principal, permitiendo respuestas más naturales y detalladas. Escribir siempre está disponible como respaldo.",
							icon: Speech,
							title: "Solo Di Lo Que Piensas",
						},
						{
							content: "¡Dembrane es más divertido en grupos!",
							cta: "Siguiente",
							extraHelp:
								"Dembrane es más divertido cuando encuentras a alguien para discutir las preguntas juntos y grabar su conversación. No podemos distinguir quién dijo qué, solo qué ideas se compartieron.",
							icon: MessagesSquare,
							title: "Solo o en Grupo",
						},
					],
				},
				{
					section: "Cómo funciona",
					slides: [
						{
							content:
								"Recibirás las preguntas una vez en el portal de grabación.",
							cta: "Entendido",
							extraHelp:
								"Las preguntas varían según las necesidades del anfitrión. Pueden ser sobre temas comunitarios, experiencias laborales o temas de investigación. Si no hay preguntas específicas, eres libre de compartir cualquier pensamiento o inquietud.",
							icon: HelpCircle,
							title: "Hora de Preguntas",
						},
					],
				},
				{
					section: "Privacidad",
					slides: [
						{
							content: "Como grabador, tú controlas lo que compartes.",
							cta: "Cuéntame más",
							extraHelp:
								"Evita compartir detalles que no quieras que el anfitrión conozca. Sé consciente y no grabes a otros sin su consentimiento.",
							icon: Lock,
							title: "La Privacidad Importa",
						},
						...(getPrivacyCard("es-ES")?.slides || []),
					],
				},
				{
					section: "Mejores Prácticas",
					slides: [
						{
							content:
								"Imagina que Dembrane está en altavoz contigo. Si puedes escucharte, estás listo.",
							cta: "Entendido",
							extraHelp:
								"Un poco de ruido de fondo está bien, siempre que se entienda quién está hablando.",
							icon: Volume2,
							title: "Reduce el Ruido de Fondo",
						},
						{
							content:
								"Asegura una conexión estable para una grabación fluida.",
							cta: "¡Listo!",
							extraHelp:
								"Wi-Fi o buenos datos móviles funcionan mejor. Si se cae tu conexión, no te preocupes. Siempre puedes reiniciar donde lo dejaste.",
							icon: Wifi,
							title: "Conexión a Internet Fuerte",
						},
						{
							content:
								"Evita interrupciones manteniendo tu dispositivo desbloqueado. Si se bloquea, simplemente desbloquéalo y continúa.",
							cta: "De acuerdo",
							extraHelp:
								"Dembrane intenta mantener tu dispositivo activo, pero a veces los dispositivos pueden anularlo. Puedes ajustar la configuración de tu dispositivo para permanecer desbloqueado más tiempo si es necesario.",
							icon: Smartphone,
							title: "¡No bloquees tu dispositivo!",
						},
					],
				},
			],
			"fr-FR": [
				{
					section: "Bienvenue",
					slides: [
						{
							content:
								"Enregistrez votre voix pour répondre aux questions et avoir un impact.",
							cta: "C'est parti !",
							extraHelp:
								"Ceci est un mini-tutoriel. Utilisez les boutons précédent et suivant pour naviguer. Une fois terminé, vous entrerez dans le portail d'enregistrement.",
							icon: PartyPopper,
							title: "Bienvenue sur Dembrane !",
						},
						{
							content:
								"Dembrane aide les gens à recueillir facilement les contributions de grands groupes.",
							cta: "Dites-m'en plus",
							extraHelp:
								"Qu'il s'agisse de commentaires pour une municipalité locale, de contributions dans un cadre professionnel ou de participation à une recherche, votre voix compte !",
							icon: Orbit,
							title: "Qu'est-ce que Dembrane ?",
						},
						{
							content:
								"Répondez aux questions à votre rythme en parlant ou en tapant.",
							cta: "Suivant",
							extraHelp:
								"La saisie vocale est notre mode principal, permettant des réponses plus naturelles et détaillées. La saisie au clavier est toujours disponible en secours.",
							icon: Speech,
							title: "Dites Simplement Ce Que Vous Pensez",
						},
						{
							content: "Dembrane est plus amusant en groupe !",
							cta: "Suivant",
							extraHelp:
								"Dembrane est plus amusant lorsque vous trouvez quelqu'un pour discuter des questions ensemble et enregistrer votre conversation. Nous ne pouvons pas dire qui a dit quoi, juste quelles idées ont été partagées.",
							icon: MessagesSquare,
							title: "Seul ou en Groupe",
						},
					],
				},
				{
					section: "Comment ça marche",
					slides: [
						{
							content:
								"Vous recevrez les questions une fois dans le portail d'enregistrement.",
							cta: "Compris",
							extraHelp:
								"Les questions varient en fonction des besoins de l'hôte. Elles peuvent concerner des problèmes communautaires, des expériences professionnelles ou des sujets de recherche. S'il n'y a pas de questions spécifiques, vous êtes libre de partager vos pensées ou préoccupations.",
							icon: HelpCircle,
							title: "Heure des Questions",
						},
					],
				},
				{
					section: "Confidentialité",
					slides: [
						{
							content:
								"En tant qu'enregistreur, vous contrôlez ce que vous partagez.",
							cta: "Dites-m'en plus",
							extraHelp:
								"Évitez de partager des détails que vous ne voulez pas que l'hôte connaisse. Soyez attentif et n'enregistrez pas les autres sans leur consentement.",
							icon: Lock,
							title: "La Confidentialité Compte",
						},
						...(getPrivacyCard("fr-FR")?.slides || []),
					],
				},
				{
					section: "Meilleures Pratiques",
					slides: [
						{
							content:
								"Imaginez que Dembrane est sur haut-parleur avec vous. Si vous pouvez vous entendre, c'est bon.",
							cta: "Noté",
							extraHelp:
								"Un peu de bruit de fond est acceptable, tant qu'on sait qui parle.",
							icon: Volume2,
							title: "Réduire le Bruit de Fond",
						},
						{
							content:
								"Assurez une connexion stable pour un enregistrement fluide.",
							cta: "Prêt !",
							extraHelp:
								"Le Wi-Fi ou de bonnes données mobiles fonctionnent mieux. Si votre connexion tombe, ne vous inquiétez pas. Vous pouvez toujours reprendre là où vous vous êtes arrêté.",
							icon: Wifi,
							title: "Connexion Internet Forte",
						},
						{
							content:
								"Évitez les interruptions en gardant votre appareil déverrouillé. S'il se verrouille, déverrouillez-le simplement et continuez.",
							cta: "D'accord",
							extraHelp:
								"Dembrane essaie de garder votre appareil actif, mais parfois les appareils peuvent l'annuler. Vous pouvez ajuster les paramètres de votre appareil pour rester déverrouillé plus longtemps si nécessaire.",
							icon: Smartphone,
							title: "Ne verrouillez pas votre appareil !",
						},
					],
				},
			],
			"it-IT": [
				{
					section: "Benvenuto",
					slides: [
						{
							content:
								"Registra la tua voce per rispondere alle domande e avere un impatto.",
							cta: "Andiamo!",
							extraHelp:
								"Questo è un mini-tutorial. Usa i pulsanti precedente e successivo per navigare. Al termine entrerai nel portale di registrazione.",
							icon: PartyPopper,
							title: "Benvenuto su Dembrane!",
						},
						{
							content:
								"Dembrane aiuta a raccogliere facilmente contributi da grandi gruppi.",
							cta: "Dimmi di più",
							extraHelp:
								"Che si tratti di feedback per un comune, di input sul lavoro o di partecipazione a una ricerca, la tua voce conta!",
							icon: Orbit,
							title: "Cos'è Dembrane?",
						},
						{
							content:
								"Rispondi alle domande a tuo ritmo parlando o scrivendo.",
							cta: "Avanti",
							extraHelp:
								"La voce è la modalità principale perché permette risposte più naturali e ricche. Scrivere è sempre disponibile come alternativa.",
							icon: Speech,
							title: "Dì semplicemente ciò che pensi",
						},
						{
							content: "Dembrane è più divertente in gruppo!",
							cta: "Avanti",
							extraHelp:
								"È ancora meglio se trovi qualcuno con cui discutere le domande e registrare la conversazione. Non possiamo sapere chi ha detto cosa, solo quali idee sono state condivise.",
							icon: MessagesSquare,
							title: "Da soli o in gruppo",
						},
					],
				},
				{
					section: "Come funziona",
					slides: [
						{
							content:
								"Riceverai le domande quando sarai nel portale di registrazione.",
							cta: "Capito",
							extraHelp:
								"Le domande variano in base alle esigenze dell'host. Possono riguardare temi della comunità, esperienze di lavoro o ricerca. Se non ci sono domande specifiche, puoi condividere qualsiasi pensiero o preoccupazione.",
							icon: HelpCircle,
							title: "È il momento delle domande",
						},
					],
				},
				{
					section: "Privacy",
					slides: [
						{
							content: "Come registratore, controlli tu ciò che condividi.",
							cta: "Dimmi di più",
							extraHelp:
								"Evita di condividere dettagli che non vuoi rendere noti all'host. Chiedi sempre il consenso prima di registrare altre persone.",
							icon: Lock,
							title: "La privacy conta",
						},
						...(getPrivacyCard("it-IT")?.slides || []),
					],
				},
				{
					section: "Migliori Pratiche",
					slides: [
						{
							content:
								"Immagina che Dembrane sia in vivavoce con te. Se riesci a sentirti, sei a posto.",
							cta: "Capito",
							extraHelp:
								"Un po' di rumore di fondo va bene, purché sia chiaro chi sta parlando.",
							icon: Volume2,
							title: "Riduci il Rumore di Fondo",
						},
						{
							content:
								"Assicurati di avere una connessione stabile per una registrazione fluida.",
							cta: "Pronto!",
							extraHelp:
								"Wi-Fi o buoni dati mobili funzionano meglio. Se la connessione cade, non preoccuparti. Puoi sempre riprendere da dove avevi interrotto.",
							icon: Wifi,
							title: "Connessione Internet Forte",
						},
						{
							content:
								"Evita interruzioni mantenendo il dispositivo sbloccato. Se si blocca, sbloccalo semplicemente e continua.",
							cta: "Okay",
							extraHelp:
								"Dembrane cerca di mantenere il dispositivo attivo, ma a volte i dispositivi possono sovrascrivere questa impostazione. Puoi regolare le impostazioni del dispositivo per rimanere sbloccato più a lungo se necessario.",
							icon: Smartphone,
							title: "Non bloccare il dispositivo!",
						},
					],
				},
			],
			"nl-NL": [
				{
					section: "Welkom",
					slides: [
						{
							content:
								"Neem je stem op om vragen te beantwoorden en impact te maken.",
							cta: "Aan de slag!",
							extraHelp:
								"Dit is een mini-handleiding. Gebruik de knoppen om te navigeren. Na afloop van de handleiding kom je in de opnameportaal terecht.",
							icon: PartyPopper,
							title: "Welkom bij Dembrane!",
						},
						{
							content:
								"Dembrane helpt mensen gemakkelijk input van grote groepen te verzamelen.",
							cta: "Vertel me meer",
							extraHelp:
								"Of het nu gaat om feedback voor de gemeente, input op het werk, of deelname aan onderzoek, jouw stem telt!",
							icon: Orbit,
							title: "Wat is Dembrane?",
						},
						{
							content:
								"Beantwoord vragen in je eigen tempo door te spreken of te typen.",
							cta: "Volgende",
							extraHelp:
								"Spraak is onze voorkeursmethode, omdat het natuurlijker en gedetailleerder is. Typen kan natuurlijk ook altijd.",
							icon: Speech,
							title: "Zeg het maar",
						},
						{
							content: "Dembrane is leuker met een groep!",
							cta: "Volgende",
							extraHelp:
								"Dembrane is leuker als je iemand vindt om de vragen samen te bespreken en jullie gesprek op te nemen. We kunnen niet horen wie wat zei, alleen welke ideeën er gedeeld zijn.",
							icon: MessagesSquare,
							title: "Alleen of in een groep",
						},
					],
				},
				{
					section: "Hoe het werkt",
					slides: [
						{
							content:
								"Je krijgt de vragen te zien zodra je in de opnameportal bent.",
							cta: "Begrepen",
							extraHelp:
								"Vragen variëren afhankelijk van wat de organisator wil weten. Het kan gaan over de buurt, werkervaringen, of onderzoeksonderwerpen. Als er geen specifieke vragen zijn, kun je gewoon je gedachten of zorgen delen.",
							icon: HelpCircle,
							title: "Vragenronde",
						},
					],
				},
				{
					section: "Privacy",
					slides: [
						{
							content: "Als opnemer heb je zelf controle over wat je deelt.",
							cta: "Vertel me meer",
							extraHelp:
								"Vermijd het delen van details die je niet met de organisator wilt delen. Wees voorzichtig en neem anderen niet op zonder hun toestemming.",
							icon: Lock,
							title: "Privacy is belangrijk",
						},
						...(getPrivacyCard("nl-NL")?.slides || []),
					],
				},
				{
					section: "Tips",
					slides: [
						{
							content:
								"Stel je voor dat Dembrane via de luidspreker met je praat. Als je jezelf kunt horen, zit je goed.",
							cta: "Begrepen",
							extraHelp:
								"Een beetje achtergrondgeluid is geen probleem, zolang duidelijk is wie er spreekt.",
							icon: Volume2,
							title: "Verminder achtergrondgeluid",
						},
						{
							content:
								"Zorg voor een stabiele verbinding voor een soepele opname.",
							cta: "Klaar!",
							extraHelp:
								"Wi-Fi of een goede mobiele verbinding werkt het beste. Valt je verbinding weg? Geen zorgen, je kunt altijd opnieuw beginnen waar je gebleven was.",
							icon: Wifi,
							title: "Goede internetverbinding",
						},
						{
							content:
								"Voorkom onderbrekingen door je apparaat ontgrendeld te houden. Als het toch vergrendelt, ontgrendel je het gewoon en ga je verder.",
							cta: "Oké",
							extraHelp:
								"Dembrane probeert je apparaat actief te houden, maar soms kunnen apparaten dit overrulen. Je kunt de instellingen van je apparaat aanpassen om langer ontgrendeld te blijven als dat nodig is.",
							icon: Smartphone,
							title: "Vergrendel je apparaat niet!",
						},
					],
				},
			],
		};

		// Fallback to English if language not found
		return tutorialCards[lang] || tutorialCards["en-US"] || [];
	};

	const getPrivacyCard = (
		lang: string,
	): LanguageCards[string][number] | null => {
		const privacyCards: Record<string, LanguageCards[string][number]> = {
			"de-DE": {
				section: "Privatsphäre",
				slides: [
					{
						checkbox: {
							label: "Ich stimme der Datenschutzrichtlinie zu",
							required: true,
						},
						content:
							"Ihre Daten werden sicher gespeichert, analysiert und niemals mit Dritten geteilt.",
						cta: "Ich verstehe.",
						extraHelp:
							"Aufnahmen werden transkribiert und aufschlussreich analysiert, anschließend nach 30 Tagen gelöscht. Für spezifische Details wenden Sie sich bitte an den Host, der Ihnen den QR-Code zur Verfügung gestellt hat.",
						icon: Server,
						link: {
							label: "Die vollständige Datenschutzrichtlinie lesen",
							url: "https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115",
						},
						title: "Datenverwendung & Sicherheit",
					},
				],
			},
			"en-US": {
				section: "Privacy",
				slides: [
					{
						checkbox: {
							label: "I agree to the privacy policy",
							required: true,
						},
						content:
							"Your data is securely stored, analyzed, and never shared with third parties.",
						cta: "I understand",
						extraHelp:
							"Recordings are transcribed and analyzed for insights, then deleted after 30 days. For specific details, consult the host who provided your QR code.",
						icon: Server,
						link: {
							label: "Read the full privacy policy",
							url: "https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115",
						},
						title: "Data Usage & Security",
					},
				],
			},
			"es-ES": {
				section: "Privacidad",
				slides: [
					{
						checkbox: {
							label: "Acepto la política de privacidad",
							required: true,
						},
						content:
							"Sus datos se almacenan de forma segura, se analizan y nunca se comparten con terceros.",
						cta: "Entiendo",
						extraHelp:
							"Las grabaciones se transcriben y analizan para obtener información, luego se eliminan después de 30 días. Para detalles específicos, consulte al anfitrión que le proporcionó su código QR.",
						icon: Server,
						link: {
							label: "Lea la política de privacidad completa",
							url: "https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115",
						},
						title: "Uso de Datos y Seguridad",
					},
				],
			},
			"fr-FR": {
				section: "Confidentialité",
				slides: [
					{
						checkbox: {
							label: "J'accepte la politique de confidentialité",
							required: true,
						},
						content:
							"Vos données sont stockées en toute sécurité, analysées et jamais partagées avec des tiers.",
						cta: "Je comprends",
						extraHelp:
							"Les enregistrements sont transcrits et analysés pour obtenir des informations, puis supprimés après 30 jours. Pour des détails spécifiques, consultez l'hôte qui vous a fourni votre code QR.",
						icon: Server,
						link: {
							label: "Lire la politique de confidentialité complète",
							url: "https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115",
						},
						title: "Utilisation des Données et Sécurité",
					},
				],
			},
			"it-IT": {
				section: "Privacy",
				slides: [
					{
						checkbox: {
							label: "Accetto l'informativa sulla privacy",
							required: true,
						},
						content:
							"I tuoi dati sono archiviati in modo sicuro, analizzati e mai condivisi con terze parti.",
						cta: "Ho capito",
						extraHelp:
							"Le registrazioni vengono trascritte e analizzate per ottenere insight, poi eliminate dopo 30 giorni. Per dettagli specifici, contatta l'host che ti ha fornito il QR code.",
						icon: Server,
						link: {
							label: "Leggi l'informativa completa sulla privacy",
							url: "https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115",
						},
						title: "Uso dei dati e sicurezza",
					},
				],
			},
			"nl-NL": {
				section: "Privacy",
				slides: [
					{
						checkbox: {
							label: "Ik ga akkoord met het privacybeleid",
							required: true,
						},
						content:
							"Je gegevens worden veilig opgeslagen, geanalyseerd en nooit gedeeld met derden.",
						cta: "Ik begrijp het",
						extraHelp:
							"Opnames worden getranscribeerd en geanalyseerd voor inzichten, en na 30 dagen verwijderd. Voor specifieke details, raadpleeg de organisator die je de QR-code heeft gegeven.",
						icon: Server,
						link: {
							label: "Lees het privacybeleid",
							url: "https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115",
						},
						title: "Gegevensgebruik & Beveiliging",
					},
				],
			},
		};

		return privacyCards[lang] || null;
	};

	return { getSystemCards };
};
