import { t } from "@lingui/core/macro";
import { NativeSelect } from "@mantine/core";
import type { ChangeEvent } from "react";
import { useLocation } from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";

const data: Array<{
	language: (typeof SUPPORTED_LANGUAGES)[number];
	iso639_1: string;
	label: string;
	flag: string;
}> = [
	{
		flag: "🇳🇱",
		iso639_1: "nl",
		label: "Nederlands",
		language: "nl-NL",
	},
	{
		flag: "🇺🇸",
		iso639_1: "en",
		label: "English",
		language: "en-US",
	},
	{
		flag: "🇩🇪",
		iso639_1: "de",
		label: "Deutsch",
		language: "de-DE",
	},
	{
		flag: "🇫🇷",
		iso639_1: "fr",
		label: "Français",
		language: "fr-FR",
	},
	{
		flag: "🇮🇹",
		iso639_1: "it",
		label: "Italiano",
		language: "it-IT",
	},
	{
		flag: "🇪🇸",
		iso639_1: "es",
		label: "Español",
		language: "es-ES",
	},
];

export const languageOptions = data.map((d) => ({
	label: `${d.label}`,
	value: d.language,
}));

export const languageOptionsByIso639_1 = data.map((d) => ({
	label: `${d.label}`,
	value: d.iso639_1,
}));

export const LanguagePicker = () => {
	const { language: currentLanguage } = useLanguage();
	const { pathname } = useLocation();

	const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
		const selectedLanguage = e.target.value;

		// If the selected language is the same as the current language, do nothing
		if (selectedLanguage === currentLanguage) return;

		// Check if we're in a chat context
		const isInChat = pathname.includes("/chats/");
		if (isInChat) {
			// biome-ignore lint/suspicious/noAlert: TODO
			const confirmed = window.confirm(
				t`Changing language during an active chat may lead to unexpected results. It's recommended to start a new chat after changing the language. Are you sure you want to continue?`,
			);
			if (!confirmed) {
				return;
			}
		}

		let newPathname = pathname;

		// Remove existing language from the pathname
		SUPPORTED_LANGUAGES.forEach((lang) => {
			if (newPathname.startsWith(`/${lang}/`)) {
				newPathname = newPathname.replace(`/${lang}`, "");
			} else if (newPathname === `/${lang}`) {
				newPathname = "/";
			}
		});

		// use browser history to navigate to the new language path
		// otherwise the language change found to be inconsistent!
		window.location.href = `/${selectedLanguage}${newPathname}`;
	};

	return (
		<NativeSelect
			data={languageOptions}
			value={currentLanguage}
			onChange={handleChange}
		/>
	);
};
