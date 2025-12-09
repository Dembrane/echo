import { Server } from "lucide-react";
import type { LanguageCards } from "../ParticipantOnboardingCards";

export const useOnboardingCards = () => {
	const getSystemCards = (
		lang: string,
		tutorialSlug?: string,
	): LanguageCards[string] => {
		const cards: LanguageCards[string] = [];

		const normalizedSlug = tutorialSlug?.toLowerCase();
		if (normalizedSlug === "none") {
			return cards;
		}

		// For 'basic' mode, show the privacy card
		const privacyCard = getPrivacyCard(lang);
		if (privacyCard) {
			cards.push(privacyCard);
		}

		return cards;
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
