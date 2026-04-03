import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { NativeSelect } from "@mantine/core";
import type { ChangeEvent } from "react";
import { useState } from "react";
import { useLocation } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";

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
	const [pendingLanguage, setPendingLanguage] = useState<string | null>(null);

	const applyLanguageChange = (selectedLanguage: string) => {
		const validLanguage = SUPPORTED_LANGUAGES.find(
			(lang) => lang === selectedLanguage,
		);
		if (!validLanguage) return;

		let newPathname = pathname;

		SUPPORTED_LANGUAGES.forEach((lang) => {
			if (newPathname.startsWith(`/${lang}/`)) {
				newPathname = newPathname.replace(`/${lang}`, "");
			} else if (newPathname === `/${lang}`) {
				newPathname = "/";
			}
		});

		window.location.href = `/${validLanguage}${newPathname}`;
	};

	const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
		const selectedLanguage = e.target.value;

		if (selectedLanguage === currentLanguage) return;

		const isInChat = pathname.includes("/chats/");
		if (isInChat) {
			setPendingLanguage(selectedLanguage);
			return;
		}

		applyLanguageChange(selectedLanguage);
	};

	return (
		<>
			<NativeSelect
				value={currentLanguage}
				onChange={handleChange}
				{...testId("header-language-picker")}
			>
				{languageOptions.map((option) => (
					<option
						key={option.value}
						value={option.value}
						data-testid={`header-language-option-${option.value}`}
					>
						{option.label}
					</option>
				))}
			</NativeSelect>

			<ConfirmModal
				opened={!!pendingLanguage}
				onClose={() => setPendingLanguage(null)}
				title={t`Change language`}
				data-testid="language-change-modal"
				message={t`Changing language during an active chat may lead to unexpected results. It's recommended to start a new chat after changing the language. Are you sure you want to continue?`}
				confirmLabel={<Trans>Continue</Trans>}
				onConfirm={() => {
					if (pendingLanguage) {
						applyLanguageChange(pendingLanguage);
						setPendingLanguage(null);
					}
				}}
			/>
		</>
	);
};
