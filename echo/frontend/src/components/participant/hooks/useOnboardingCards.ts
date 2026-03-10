import type { LanguageCards } from "../ParticipantOnboardingCards";

type LegalBasis = ParticipantProject["legal_basis"];

export const useOnboardingCards = () => {
	const getSystemCards = (
		lang: string,
		tutorialSlug?: string,
		legalBasis?: LegalBasis,
		privacyPolicyUrl?: string | null,
	): LanguageCards[string] => {
		const basis = legalBasis ?? "client-managed";

		// Normalize and fallback invalid values to "none"
		const normalizedSlug = tutorialSlug?.toLowerCase();
		const validSlugs = ["none", "basic", "advanced"];
		const finalSlug = validSlugs.includes(normalizedSlug || "")
			? normalizedSlug
			: "none";

		// none: Only privacy statement
		if (finalSlug === "none") {
			const privacyCard = getPrivacyCard(lang, basis, privacyPolicyUrl);
			return privacyCard ? [privacyCard] : [];
		}

		// basic: Tutorial slides + privacy statement
		if (finalSlug === "basic") {
			const tutorialCards = getBasicTutorialCards(lang);
			const privacyCard = getPrivacyCard(lang, basis, privacyPolicyUrl);
			return [...tutorialCards, ...(privacyCard ? [privacyCard] : [])];
		}

		// advanced: Full tutorial + privacy statement + best practices
		if (finalSlug === "advanced") {
			const tutorialCards = getAdvancedTutorialCards(
				lang,
				basis,
				privacyPolicyUrl,
			);
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
							title: "Willkommen bei Dembrane!",
						},
						{
							content:
								"Dembrane hilft Menschen, einfach Input von großen Gruppen zu sammeln.",
							cta: "Mehr erfahren",
							extraHelp:
								"Ob Feedback für eine Kommune, Input im Arbeitsumfeld oder Teilnahme an Forschung – Ihre Stimme zählt!",
							title: "Was ist Dembrane?",
						},
						{
							content:
								"Beantworten Sie Fragen in Ihrem eigenen Tempo durch Sprechen oder Tippen.",
							cta: "Weiter",
							extraHelp:
								"Spracheingabe ist unser bevorzugter Modus, da sie natürlichere und detailliertere Antworten ermöglicht. Tippen steht immer als Alternative zur Verfügung.",
							title: "Sagen Sie einfach Ihre Meinung",
						},
						{
							content: "Dembrane macht in Gruppen mehr Spaß!",
							cta: "Weiter",
							extraHelp:
								"Dembrane macht mehr Spaß, wenn Sie jemanden finden, um die Fragen gemeinsam zu besprechen und Ihr Gespräch aufzunehmen. Wir können nicht sagen, wer was gesagt hat, nur welche Ideen geteilt wurden.",
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
							title: "Welcome to Dembrane!",
						},
						{
							content:
								"Dembrane helps people gather input from large groups easily.",
							cta: "Tell me more",
							extraHelp:
								"Whether it's feedback for a local municipality, input in a work setting, or participation in research, your voice matters!",
							title: "What is Dembrane?",
						},
						{
							content:
								"Answer questions in your own time by speaking or typing.",
							cta: "Next",
							extraHelp:
								"Voice input is our primary mode, allowing for more natural and detailed responses. Typing is always available as a backup.",
							title: "Just Speak Your Mind",
						},
						{
							content: "Dembrane is more fun in groups!",
							cta: "Next",
							extraHelp:
								"Dembrane is more fun when you find someone to discuss the questions together and record your conversation. We can't tell who said what, just what ideas were shared.",
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
							title: "¡Bienvenido a Dembrane!",
						},
						{
							content:
								"Dembrane ayuda a las personas a recopilar aportaciones de grandes grupos fácilmente.",
							cta: "Cuéntame más",
							extraHelp:
								"Ya sea retroalimentación para una municipalidad local, aportaciones en el trabajo o participación en investigación, ¡tu voz importa!",
							title: "¿Qué es Dembrane?",
						},
						{
							content:
								"Responde preguntas a tu propio ritmo hablando o escribiendo.",
							cta: "Siguiente",
							extraHelp:
								"La entrada de voz es nuestro modo principal, permitiendo respuestas más naturales y detalladas. Escribir siempre está disponible como respaldo.",
							title: "Solo Di Lo Que Piensas",
						},
						{
							content: "¡Dembrane es más divertido en grupos!",
							cta: "Siguiente",
							extraHelp:
								"Dembrane es más divertido cuando encuentras a alguien para discutir las preguntas juntos y grabar su conversación. No podemos distinguir quién dijo qué, solo qué ideas se compartieron.",
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
							title: "Bienvenue sur Dembrane !",
						},
						{
							content:
								"Dembrane aide les gens à recueillir facilement les contributions de grands groupes.",
							cta: "Dites-m'en plus",
							extraHelp:
								"Qu'il s'agisse de commentaires pour une municipalité locale, de contributions dans un cadre professionnel ou de participation à une recherche, votre voix compte !",
							title: "Qu'est-ce que Dembrane ?",
						},
						{
							content:
								"Répondez aux questions à votre rythme en parlant ou en tapant.",
							cta: "Suivant",
							extraHelp:
								"La saisie vocale est notre mode principal, permettant des réponses plus naturelles et détaillées. La saisie au clavier est toujours disponible en secours.",
							title: "Dites Simplement Ce Que Vous Pensez",
						},
						{
							content: "Dembrane est plus amusant en groupe !",
							cta: "Suivant",
							extraHelp:
								"Dembrane est plus amusant lorsque vous trouvez quelqu'un pour discuter des questions ensemble et enregistrer votre conversation. Nous ne pouvons pas dire qui a dit quoi, juste quelles idées ont été partagées.",
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
							title: "Benvenuto su Dembrane!",
						},
						{
							content:
								"Dembrane aiuta a raccogliere facilmente contributi da grandi gruppi.",
							cta: "Dimmi di più",
							extraHelp:
								"Che si tratti di feedback per un comune, di input sul lavoro o di partecipazione a una ricerca, la tua voce conta!",
							title: "Cos'è Dembrane?",
						},
						{
							content:
								"Rispondi alle domande a tuo ritmo parlando o scrivendo.",
							cta: "Avanti",
							extraHelp:
								"La voce è la modalità principale perché permette risposte più naturali e ricche. Scrivere è sempre disponibile come alternativa.",
							title: "Dì semplicemente ciò che pensi",
						},
						{
							content: "Dembrane è più divertente in gruppo!",
							cta: "Avanti",
							extraHelp:
								"È ancora meglio se trovi qualcuno con cui discutere le domande e registrare la conversazione. Non possiamo sapere chi ha detto cosa, solo quali idee sono state condivise.",
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
							title: "Welkom bij Dembrane!",
						},
						{
							content:
								"Dembrane helpt mensen gemakkelijk input van grote groepen te verzamelen.",
							cta: "Vertel me meer",
							extraHelp:
								"Of het nu gaat om feedback voor de gemeente, input op het werk, of deelname aan onderzoek, jouw stem telt!",
							title: "Wat is Dembrane?",
						},
						{
							content:
								"Beantwoord vragen in je eigen tempo door te spreken of te typen.",
							cta: "Volgende",
							extraHelp:
								"Spraak is onze voorkeursmethode, omdat het natuurlijker en gedetailleerder is. Typen kan natuurlijk ook altijd.",
							title: "Zeg het maar",
						},
						{
							content: "Dembrane is leuker met een groep!",
							cta: "Volgende",
							extraHelp:
								"Dembrane is leuker als je iemand vindt om de vragen samen te bespreken en jullie gesprek op te nemen. We kunnen niet horen wie wat zei, alleen welke ideeën er gedeeld zijn.",
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
							title: "Privacy is belangrijk",
						},
					],
				},
			],
		};

		// Fallback to English if language not found
		return tutorialCards[lang] || tutorialCards["en-US"] || [];
	};

	const getAdvancedTutorialCards = (
		lang: string,
		legalBasis: LegalBasis = "client-managed",
		privacyPolicyUrl?: string | null,
	): LanguageCards[string] => {
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
							title: "Willkommen bei Dembrane!",
						},
						{
							content:
								"Dembrane hilft Menschen, einfach Input von großen Gruppen zu sammeln.",
							cta: "Mehr erfahren",
							extraHelp:
								"Ob Feedback für eine Kommune, Input im Arbeitsumfeld oder Teilnahme an Forschung – Ihre Stimme zählt!",
							title: "Was ist Dembrane?",
						},
						{
							content:
								"Beantworten Sie Fragen in Ihrem eigenen Tempo durch Sprechen oder Tippen.",
							cta: "Weiter",
							extraHelp:
								"Spracheingabe ist unser bevorzugter Modus, da sie natürlichere und detailliertere Antworten ermöglicht. Tippen steht immer als Alternative zur Verfügung.",
							title: "Sagen Sie einfach Ihre Meinung",
						},
						{
							content: "Dembrane macht in Gruppen mehr Spaß!",
							cta: "Weiter",
							extraHelp:
								"Dembrane macht mehr Spaß, wenn Sie jemanden finden, um die Fragen gemeinsam zu besprechen und Ihr Gespräch aufzunehmen. Wir können nicht sagen, wer was gesagt hat, nur welche Ideen geteilt wurden.",
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
							title: "Datenschutz ist wichtig",
						},
						...(getPrivacyCard("de-DE", legalBasis, privacyPolicyUrl)?.slides ||
							[]),
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
							title: "Hintergrundgeräusche reduzieren",
						},
						{
							content:
								"Stellen Sie eine stabile Verbindung für eine reibungslose Aufnahme sicher.",
							cta: "Bereit!",
							extraHelp:
								"WLAN oder gute mobile Daten funktionieren am besten. Wenn Ihre Verbindung abbricht, keine Sorge. Sie können immer dort weitermachen, wo Sie aufgehört haben.",
							title: "Starke Internetverbindung",
						},
						{
							content:
								"Vermeiden Sie Unterbrechungen, indem Sie Ihr Gerät entsperrt halten. Wenn es sich sperrt, entsperren Sie es einfach und fahren Sie fort.",
							cta: "Okay",
							extraHelp:
								"Dembrane versucht, Ihr Gerät aktiv zu halten, aber manchmal können Geräte dies überschreiben. Sie können Ihre Geräteeinstellungen anpassen, um länger entsperrt zu bleiben, wenn nötig.",
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
							title: "Welcome to Dembrane!",
						},
						{
							content:
								"Dembrane helps people gather input from large groups easily.",
							cta: "Tell me more",
							extraHelp:
								"Whether it's feedback for a local municipality, input in a work setting, or participation in research, your voice matters!",
							title: "What is Dembrane?",
						},
						{
							content:
								"Answer questions in your own time by speaking or typing.",
							cta: "Next",
							extraHelp:
								"Voice input is our primary mode, allowing for more natural and detailed responses. Typing is always available as a backup.",
							title: "Just Speak Your Mind",
						},
						{
							content: "Dembrane is more fun in groups!",
							cta: "Next",
							extraHelp:
								"Dembrane is more fun when you find someone to discuss the questions together and record your conversation. We can't tell who said what, just what ideas were shared.",
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
							title: "Privacy Matters",
						},
						...(getPrivacyCard("en-US", legalBasis, privacyPolicyUrl)?.slides ||
							[]),
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
							title: "Reduce Background Noise",
						},
						{
							content: "Ensure a stable connection for smooth recording.",
							cta: "Ready!",
							extraHelp:
								"Wi-Fi or good mobile data works best. If your connection drops, don't worry. You can always restart where you left off.",
							title: "Strong Internet Connection",
						},
						{
							content:
								"Prevent interruptions by keeping your device unlocked. If it locks, just unlock and continue.",
							cta: "Okay",
							extraHelp:
								"Dembrane tries to keep your device active, but sometimes devices can override it, for example if you have low power mode active. You can adjust your device settings to stay unlocked longer if needed.",
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
							title: "¡Bienvenido a Dembrane!",
						},
						{
							content:
								"Dembrane ayuda a las personas a recopilar aportaciones de grandes grupos fácilmente.",
							cta: "Cuéntame más",
							extraHelp:
								"Ya sea retroalimentación para una municipalidad local, aportaciones en el trabajo o participación en investigación, ¡tu voz importa!",
							title: "¿Qué es Dembrane?",
						},
						{
							content:
								"Responde preguntas a tu propio ritmo hablando o escribiendo.",
							cta: "Siguiente",
							extraHelp:
								"La entrada de voz es nuestro modo principal, permitiendo respuestas más naturales y detalladas. Escribir siempre está disponible como respaldo.",
							title: "Solo Di Lo Que Piensas",
						},
						{
							content: "¡Dembrane es más divertido en grupos!",
							cta: "Siguiente",
							extraHelp:
								"Dembrane es más divertido cuando encuentras a alguien para discutir las preguntas juntos y grabar su conversación. No podemos distinguir quién dijo qué, solo qué ideas se compartieron.",
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
							title: "La Privacidad Importa",
						},
						...(getPrivacyCard("es-ES", legalBasis, privacyPolicyUrl)?.slides ||
							[]),
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
							title: "Reduce el Ruido de Fondo",
						},
						{
							content:
								"Asegura una conexión estable para una grabación fluida.",
							cta: "¡Listo!",
							extraHelp:
								"Wi-Fi o buenos datos móviles funcionan mejor. Si se cae tu conexión, no te preocupes. Siempre puedes reiniciar donde lo dejaste.",
							title: "Conexión a Internet Fuerte",
						},
						{
							content:
								"Evita interrupciones manteniendo tu dispositivo desbloqueado. Si se bloquea, simplemente desbloquéalo y continúa.",
							cta: "De acuerdo",
							extraHelp:
								"Dembrane intenta mantener tu dispositivo activo, pero a veces los dispositivos pueden anularlo. Puedes ajustar la configuración de tu dispositivo para permanecer desbloqueado más tiempo si es necesario.",
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
							title: "Bienvenue sur Dembrane !",
						},
						{
							content:
								"Dembrane aide les gens à recueillir facilement les contributions de grands groupes.",
							cta: "Dites-m'en plus",
							extraHelp:
								"Qu'il s'agisse de commentaires pour une municipalité locale, de contributions dans un cadre professionnel ou de participation à une recherche, votre voix compte !",
							title: "Qu'est-ce que Dembrane ?",
						},
						{
							content:
								"Répondez aux questions à votre rythme en parlant ou en tapant.",
							cta: "Suivant",
							extraHelp:
								"La saisie vocale est notre mode principal, permettant des réponses plus naturelles et détaillées. La saisie au clavier est toujours disponible en secours.",
							title: "Dites Simplement Ce Que Vous Pensez",
						},
						{
							content: "Dembrane est plus amusant en groupe !",
							cta: "Suivant",
							extraHelp:
								"Dembrane est plus amusant lorsque vous trouvez quelqu'un pour discuter des questions ensemble et enregistrer votre conversation. Nous ne pouvons pas dire qui a dit quoi, juste quelles idées ont été partagées.",
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
							title: "La Confidentialité Compte",
						},
						...(getPrivacyCard("fr-FR", legalBasis, privacyPolicyUrl)?.slides ||
							[]),
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
							title: "Réduire le Bruit de Fond",
						},
						{
							content:
								"Assurez une connexion stable pour un enregistrement fluide.",
							cta: "Prêt !",
							extraHelp:
								"Le Wi-Fi ou de bonnes données mobiles fonctionnent mieux. Si votre connexion tombe, ne vous inquiétez pas. Vous pouvez toujours reprendre là où vous vous êtes arrêté.",
							title: "Connexion Internet Forte",
						},
						{
							content:
								"Évitez les interruptions en gardant votre appareil déverrouillé. S'il se verrouille, déverrouillez-le simplement et continuez.",
							cta: "D'accord",
							extraHelp:
								"Dembrane essaie de garder votre appareil actif, mais parfois les appareils peuvent l'annuler. Vous pouvez ajuster les paramètres de votre appareil pour rester déverrouillé plus longtemps si nécessaire.",
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
							title: "Benvenuto su Dembrane!",
						},
						{
							content:
								"Dembrane aiuta a raccogliere facilmente contributi da grandi gruppi.",
							cta: "Dimmi di più",
							extraHelp:
								"Che si tratti di feedback per un comune, di input sul lavoro o di partecipazione a una ricerca, la tua voce conta!",
							title: "Cos'è Dembrane?",
						},
						{
							content:
								"Rispondi alle domande a tuo ritmo parlando o scrivendo.",
							cta: "Avanti",
							extraHelp:
								"La voce è la modalità principale perché permette risposte più naturali e ricche. Scrivere è sempre disponibile come alternativa.",
							title: "Dì semplicemente ciò che pensi",
						},
						{
							content: "Dembrane è più divertente in gruppo!",
							cta: "Avanti",
							extraHelp:
								"È ancora meglio se trovi qualcuno con cui discutere le domande e registrare la conversazione. Non possiamo sapere chi ha detto cosa, solo quali idee sono state condivise.",
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
							title: "La privacy conta",
						},
						...(getPrivacyCard("it-IT", legalBasis, privacyPolicyUrl)?.slides ||
							[]),
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
							title: "Riduci il Rumore di Fondo",
						},
						{
							content:
								"Assicurati di avere una connessione stabile per una registrazione fluida.",
							cta: "Pronto!",
							extraHelp:
								"Wi-Fi o buoni dati mobili funzionano meglio. Se la connessione cade, non preoccuparti. Puoi sempre riprendere da dove avevi interrotto.",
							title: "Connessione Internet Forte",
						},
						{
							content:
								"Evita interruzioni mantenendo il dispositivo sbloccato. Se si blocca, sbloccalo semplicemente e continua.",
							cta: "Okay",
							extraHelp:
								"Dembrane cerca di mantenere il dispositivo attivo, ma a volte i dispositivi possono sovrascrivere questa impostazione. Puoi regolare le impostazioni del dispositivo per rimanere sbloccato più a lungo se necessario.",
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
							title: "Welkom bij Dembrane!",
						},
						{
							content:
								"Dembrane helpt mensen gemakkelijk input van grote groepen te verzamelen.",
							cta: "Vertel me meer",
							extraHelp:
								"Of het nu gaat om feedback voor de gemeente, input op het werk, of deelname aan onderzoek, jouw stem telt!",
							title: "Wat is Dembrane?",
						},
						{
							content:
								"Beantwoord vragen in je eigen tempo door te spreken of te typen.",
							cta: "Volgende",
							extraHelp:
								"Spraak is onze voorkeursmethode, omdat het natuurlijker en gedetailleerder is. Typen kan natuurlijk ook altijd.",
							title: "Zeg het maar",
						},
						{
							content: "Dembrane is leuker met een groep!",
							cta: "Volgende",
							extraHelp:
								"Dembrane is leuker als je iemand vindt om de vragen samen te bespreken en jullie gesprek op te nemen. We kunnen niet horen wie wat zei, alleen welke ideeën er gedeeld zijn.",
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
							title: "Privacy is belangrijk",
						},
						...(getPrivacyCard("nl-NL", legalBasis, privacyPolicyUrl)?.slides ||
							[]),
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
							title: "Verminder achtergrondgeluid",
						},
						{
							content:
								"Zorg voor een stabiele verbinding voor een soepele opname.",
							cta: "Klaar!",
							extraHelp:
								"Wi-Fi of een goede mobiele verbinding werkt het beste. Valt je verbinding weg? Geen zorgen, je kunt altijd opnieuw beginnen waar je gebleven was.",
							title: "Goede internetverbinding",
						},
						{
							content:
								"Voorkom onderbrekingen door je apparaat ontgrendeld te houden. Als het toch vergrendelt, ontgrendel je het gewoon en ga je verder.",
							cta: "Oké",
							extraHelp:
								"Dembrane probeert je apparaat actief te houden, maar soms kunnen apparaten dit overrulen. Je kunt de instellingen van je apparaat aanpassen om langer ontgrendeld te blijven als dat nodig is.",
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
		legalBasis: LegalBasis = "client-managed",
		privacyPolicyUrl?: string | null,
	): LanguageCards[string][number] | null => {
		if (legalBasis === "client-managed") {
			return getClientManagedPrivacyCard(lang);
		}
		if (legalBasis === "dembrane-events") {
			return getDembraneEventsPrivacyCard(lang);
		}
		return getConsentPrivacyCard(lang, privacyPolicyUrl);
	};

	const getClientManagedPrivacyCard = (
		lang: string,
	): LanguageCards[string][number] | null => {
		const cards: Record<string, LanguageCards[string][number]> = {
			"de-DE": {
				section: "Privatsphäre",
				slides: [
					{
						content:
							"Der Organisator ist verantwortlich dafür, wie Ihre Daten in dieser Sitzung verwendet werden. dembrane verarbeitet Ihr Gespräch in seinem Auftrag.",
						cta: "Ich verstehe.",
						extraHelp:
							"Aufnahmen werden transkribiert und für Erkenntnisse analysiert. Ihre Daten werden auf gesicherten Servern in Europa gespeichert, nicht zum Trainieren von KI-Modellen verwendet und innerhalb von 30 Tagen nach Projektende gelöscht.\n\nFragen zu Ihrer Privatsphäre? Wenden Sie sich direkt an den Organisator.",
						title: "Verantwortlicher, Nutzung und Sicherheit.",
					},
				],
			},
			"en-US": {
				section: "Privacy",
				slides: [
					{
						content:
							"The organiser is responsible for how your data is used in this session. dembrane processes your conversation on their behalf.",
						cta: "I understand",
						extraHelp:
							"Recordings are transcribed and analysed for insights. Your data is stored on secured servers in Europe, is not used to train AI models, and is deleted within 30 days after the project has ended.\n\nQuestions about your privacy? Contact the organiser directly.",
						title: "Data controller, usage and security.",
					},
				],
			},
			"es-ES": {
				section: "Privacidad",
				slides: [
					{
						content:
							"El organizador es responsable de cómo se utilizan sus datos en esta sesión. dembrane procesa su conversación en su nombre.",
						cta: "Entiendo",
						extraHelp:
							"Las grabaciones se transcriben y analizan para obtener información. Sus datos se almacenan en servidores seguros en Europa, no se utilizan para entrenar modelos de IA y se eliminan dentro de los 30 días posteriores a la finalización del proyecto.\n\n¿Preguntas sobre su privacidad? Contacte directamente al organizador.",
						title: "Responsable del tratamiento, uso y seguridad.",
					},
				],
			},
			"fr-FR": {
				section: "Confidentialité",
				slides: [
					{
						content:
							"L'organisateur est responsable de la manière dont vos données sont utilisées dans cette session. dembrane traite votre conversation en son nom.",
						cta: "Je comprends",
						extraHelp:
							"Les enregistrements sont transcrits et analysés pour en tirer des enseignements. Vos données sont stockées sur des serveurs sécurisés en Europe, ne sont pas utilisées pour entraîner des modèles d'IA et sont supprimées dans les 30 jours suivant la fin du projet.\n\nDes questions sur votre vie privée ? Contactez directement l'organisateur.",
						title: "Responsable du traitement, utilisation et sécurité.",
					},
				],
			},
			"it-IT": {
				section: "Privacy",
				slides: [
					{
						content:
							"L'organizzatore è responsabile di come vengono utilizzati i tuoi dati in questa sessione. dembrane elabora la tua conversazione per suo conto.",
						cta: "Ho capito",
						extraHelp:
							"Le registrazioni vengono trascritte e analizzate per ottenere insight. I tuoi dati sono archiviati su server sicuri in Europa, non vengono utilizzati per addestrare modelli di IA e vengono eliminati entro 30 giorni dalla fine del progetto.\n\nDomande sulla tua privacy? Contatta direttamente l'organizzatore.",
						title: "Titolare del trattamento, utilizzo e sicurezza.",
					},
				],
			},
			"nl-NL": {
				section: "Privacy",
				slides: [
					{
						content:
							"De organisator is verantwoordelijk voor hoe jouw gegevens worden gebruikt in deze sessie. dembrane verwerkt jouw gesprek namens hen.",
						cta: "Ik begrijp het",
						extraHelp:
							"Opnames worden getranscribeerd en geanalyseerd om inzichten te genereren. Jouw gegevens worden opgeslagen op beveiligde servers in Europa, niet gebruikt om AI-modellen te trainen, en verwijderd binnen 30 dagen na afloop van het project.\n\nVragen over jouw privacy? Neem contact op met de organisator.",
						title: "Verwerkingsverantwoordelijke, gebruik en beveiliging.",
					},
				],
			},
		};

		return cards[lang] || cards["en-US"] || null;
	};

	const getConsentPrivacyCard = (
		lang: string,
		privacyPolicyUrl?: string | null,
	): LanguageCards[string][number] | null => {
		const policyUrl = privacyPolicyUrl || undefined;

		const cards: Record<string, LanguageCards[string][number]> = {
			"de-DE": {
				section: "Privatsphäre",
				slides: [
					{
						checkbox: {
							label:
								"Ich stimme zu, dass mein Gespräch aufgezeichnet und verarbeitet wird.",
							required: true,
						},
						content:
							"Der Organisator ist verantwortlich dafür, wie Ihre Daten in dieser Sitzung verwendet werden. dembrane verarbeitet Ihr Gespräch in seinem Auftrag.",
						cta: "Ich verstehe.",
						extraHelp:
							"Aufnahmen werden transkribiert und für Erkenntnisse analysiert. Ihre Daten werden auf gesicherten Servern in Europa gespeichert, nicht zum Trainieren von KI-Modellen verwendet und innerhalb von 30 Tagen nach Projektende gelöscht.\n\nFragen zu Ihrer Privatsphäre? Wenden Sie sich direkt an den Organisator.",
						...(policyUrl
							? {
									link: {
										label: "Datenschutzrichtlinie des Organisators lesen",
										url: policyUrl,
									},
								}
							: {}),
						title: "Verantwortlicher, Nutzung und Sicherheit.",
					},
				],
			},
			"en-US": {
				section: "Privacy",
				slides: [
					{
						checkbox: {
							label:
								"I consent to my conversation being recorded and processed.",
							required: true,
						},
						content:
							"The organiser is responsible for how your data is used in this session. dembrane processes your conversation on their behalf.",
						cta: "I understand",
						extraHelp:
							"Recordings are transcribed and analysed for insights. Your data is stored on secured servers in Europe, is not used to train AI models, and is deleted within 30 days after the project has ended.\n\nQuestions about your privacy? Contact the organiser directly.",
						...(policyUrl
							? {
									link: {
										label: "Read the organiser's privacy policy",
										url: policyUrl,
									},
								}
							: {}),
						title: "Data controller, usage and security.",
					},
				],
			},
			"es-ES": {
				section: "Privacidad",
				slides: [
					{
						checkbox: {
							label:
								"Doy mi consentimiento para que mi conversación sea grabada y procesada.",
							required: true,
						},
						content:
							"El organizador es responsable de cómo se utilizan sus datos en esta sesión. dembrane procesa su conversación en su nombre.",
						cta: "Entiendo",
						extraHelp:
							"Las grabaciones se transcriben y analizan para obtener información. Sus datos se almacenan en servidores seguros en Europa, no se utilizan para entrenar modelos de IA y se eliminan dentro de los 30 días posteriores a la finalización del proyecto.\n\n¿Preguntas sobre su privacidad? Contacte directamente al organizador.",
						...(policyUrl
							? {
									link: {
										label: "Lea la política de privacidad del organizador",
										url: policyUrl,
									},
								}
							: {}),
						title: "Responsable del tratamiento, uso y seguridad.",
					},
				],
			},
			"fr-FR": {
				section: "Confidentialité",
				slides: [
					{
						checkbox: {
							label:
								"Je consens à ce que ma conversation soit enregistrée et traitée.",
							required: true,
						},
						content:
							"L'organisateur est responsable de la manière dont vos données sont utilisées dans cette session. dembrane traite votre conversation en son nom.",
						cta: "Je comprends",
						extraHelp:
							"Les enregistrements sont transcrits et analysés pour en tirer des enseignements. Vos données sont stockées sur des serveurs sécurisés en Europe, ne sont pas utilisées pour entraîner des modèles d'IA et sont supprimées dans les 30 jours suivant la fin du projet.\n\nDes questions sur votre vie privée ? Contactez directement l'organisateur.",
						...(policyUrl
							? {
									link: {
										label:
											"Lire la politique de confidentialité de l'organisateur",
										url: policyUrl,
									},
								}
							: {}),
						title: "Responsable du traitement, utilisation et sécurité.",
					},
				],
			},
			"it-IT": {
				section: "Privacy",
				slides: [
					{
						checkbox: {
							label:
								"Acconsento alla registrazione e al trattamento della mia conversazione.",
							required: true,
						},
						content:
							"L'organizzatore è responsabile di come vengono utilizzati i tuoi dati in questa sessione. dembrane elabora la tua conversazione per suo conto.",
						cta: "Ho capito",
						extraHelp:
							"Le registrazioni vengono trascritte e analizzate per ottenere insight. I tuoi dati sono archiviati su server sicuri in Europa, non vengono utilizzati per addestrare modelli di IA e vengono eliminati entro 30 giorni dalla fine del progetto.\n\nDomande sulla tua privacy? Contatta direttamente l'organizzatore.",
						...(policyUrl
							? {
									link: {
										label:
											"Leggi l'informativa sulla privacy dell'organizzatore",
										url: policyUrl,
									},
								}
							: {}),
						title: "Titolare del trattamento, utilizzo e sicurezza.",
					},
				],
			},
			"nl-NL": {
				section: "Privacy",
				slides: [
					{
						checkbox: {
							label:
								"Ik geef toestemming voor het opnemen en verwerken van mijn gesprek.",
							required: true,
						},
						content:
							"De organisator is verantwoordelijk voor hoe jouw gegevens worden gebruikt in deze sessie. dembrane verwerkt jouw gesprek namens hen.",
						cta: "Ik begrijp het",
						extraHelp:
							"Opnames worden getranscribeerd en geanalyseerd om inzichten te genereren. Jouw gegevens worden opgeslagen op beveiligde servers in Europa, niet gebruikt om AI-modellen te trainen, en verwijderd binnen 30 dagen na afloop van het project.\n\nVragen over jouw privacy? Neem contact op met de organisator.",
						...(policyUrl
							? {
									link: {
										label: "Lees het privacybeleid van de organisator",
										url: policyUrl,
									},
								}
							: {}),
						title: "Verwerkingsverantwoordelijke, gebruik en beveiliging.",
					},
				],
			},
		};

		return cards[lang] || cards["en-US"] || null;
	};

	const getDembraneEventsPrivacyCard = (
		lang: string,
	): LanguageCards[string][number] | null => {
		const dembranePrivacyUrl =
			"https://dembrane.notion.site/Privacy-Statement-Dembrane-1439cd84270580748046cc589861d115";

		const cards: Record<string, LanguageCards[string][number]> = {
			"de-DE": {
				section: "Privatsphäre",
				slides: [
					{
						content:
							"dembrane zeichnet dieses Gespräch auf und analysiert es auf Grundlage unseres berechtigten Interesses: Diskussionen genau festzuhalten, zuverlässige Erkenntnisse zu liefern und unsere Plattform weiterzuentwickeln.",
						cta: "Ich verstehe.",
						extraHelp:
							"Aufnahmen und Transkripte werden innerhalb von 30 Tagen nach Schließung der Sitzung gelöscht. Daten werden auf gesicherten Servern in Europa gespeichert und nicht zum Trainieren von KI-Modellen verwendet.\n\nFragen oder Einwände? Kontaktieren Sie uns unter info@dembrane.com oder lesen Sie unsere Datenschutzrichtlinie.",
						link: {
							label: "Vollständige Datenschutzrichtlinie lesen",
							url: dembranePrivacyUrl,
						},
						title: "Datenverwendung und Sicherheit",
					},
				],
			},
			"en-US": {
				section: "Privacy",
				slides: [
					{
						content:
							"dembrane records and analyses this conversation based on our legitimate interest: to capture discussions accurately, deliver reliable insights, and develop our platform.",
						cta: "I understand",
						extraHelp:
							"Recordings and transcripts are deleted within 30 days of the session closing. Data is stored on secured servers in Europe and is not used to train AI models.\n\nQuestions or want to object? Contact us at info@dembrane.com or see our privacy policy.",
						link: {
							label: "Read the full privacy policy",
							url: dembranePrivacyUrl,
						},
						title: "Data usage and security",
					},
				],
			},
			"es-ES": {
				section: "Privacidad",
				slides: [
					{
						content:
							"dembrane graba y analiza esta conversación basándose en nuestro interés legítimo: capturar las discusiones con precisión, ofrecer información fiable y desarrollar nuestra plataforma.",
						cta: "Entiendo",
						extraHelp:
							"Las grabaciones y transcripciones se eliminan dentro de los 30 días posteriores al cierre de la sesión. Los datos se almacenan en servidores seguros en Europa y no se utilizan para entrenar modelos de IA.\n\n¿Preguntas o desea objetar? Contáctenos en info@dembrane.com o consulte nuestra política de privacidad.",
						link: {
							label: "Lea la política de privacidad completa",
							url: dembranePrivacyUrl,
						},
						title: "Uso de datos y seguridad",
					},
				],
			},
			"fr-FR": {
				section: "Confidentialité",
				slides: [
					{
						content:
							"dembrane enregistre et analyse cette conversation sur la base de notre intérêt légitime : capturer les discussions avec précision, fournir des informations fiables et développer notre plateforme.",
						cta: "Je comprends",
						extraHelp:
							"Les enregistrements et les transcriptions sont supprimés dans les 30 jours suivant la clôture de la session. Les données sont stockées sur des serveurs sécurisés en Europe et ne sont pas utilisées pour entraîner des modèles d'IA.\n\nDes questions ou souhaitez-vous vous opposer ? Contactez-nous à info@dembrane.com ou consultez notre politique de confidentialité.",
						link: {
							label: "Lire la politique de confidentialité complète",
							url: dembranePrivacyUrl,
						},
						title: "Utilisation des données et sécurité",
					},
				],
			},
			"it-IT": {
				section: "Privacy",
				slides: [
					{
						content:
							"dembrane registra e analizza questa conversazione sulla base del nostro legittimo interesse: acquisire le discussioni in modo accurato, fornire informazioni affidabili e sviluppare la nostra piattaforma.",
						cta: "Ho capito",
						extraHelp:
							"Le registrazioni e le trascrizioni vengono eliminate entro 30 giorni dalla chiusura della sessione. I dati sono archiviati su server sicuri in Europa e non vengono utilizzati per addestrare modelli di IA.\n\nDomande o vuoi opporti? Contattaci a info@dembrane.com o consulta la nostra informativa sulla privacy.",
						link: {
							label: "Leggi l'informativa sulla privacy completa",
							url: dembranePrivacyUrl,
						},
						title: "Uso dei dati e sicurezza",
					},
				],
			},
			"nl-NL": {
				section: "Privacy",
				slides: [
					{
						content:
							"dembrane neemt dit gesprek op en analyseert het op basis van ons gerechtvaardigd belang: om discussies nauwkeurig vast te leggen, betrouwbare inzichten te leveren en ons platform te ontwikkelen.",
						cta: "Ik begrijp het",
						extraHelp:
							"Opnames en transcripties worden binnen 30 dagen na het sluiten van de sessie verwijderd. Gegevens worden opgeslagen op beveiligde servers in Europa en worden niet gebruikt om AI-modellen te trainen.\n\nVragen of bezwaar indienen? Neem contact met ons op via info@dembrane.com of bekijk ons privacybeleid.",
						link: {
							label: "Lees het volledige privacybeleid",
							url: dembranePrivacyUrl,
						},
						title: "Gegevensgebruik en beveiliging",
					},
				],
			},
		};

		return cards[lang] || cards["en-US"] || null;
	};

	return { getSystemCards };
};
