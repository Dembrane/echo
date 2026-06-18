import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Group, Select } from "@mantine/core";
import { useState } from "react";
import { useLocation } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { storeLanguage } from "@/lib/language";
import { testId } from "@/lib/testUtils";
import classes from "./LanguagePicker.module.css";

const PARTIAL_LANGUAGES = new Set(["it-IT", "uk-UA", "cs-CZ"]);

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
		{
			flag: "🇺🇦",
			iso639_1: "uk",
			label: "Ukrainian",
			language: "uk-UA",
		},
		{
			flag: "🇨🇿",
			iso639_1: "cs",
			label: "Czech",
			language: "cs-CZ",
		},
];

export const languageOptions = data.map((d) => ({
	label: d.label,
	value: d.language,
}));

export const languageOptionsByIso639_1 = data.map((d) => ({
	label: d.label,
	value: d.iso639_1,
}));

export const LanguagePicker = () => {
	const { language: currentLanguage } = useLanguage();
	const { pathname, search, hash } = useLocation();
	const [pendingLanguage, setPendingLanguage] = useState<string | null>(null);

	const applyLanguageChange = (selectedLanguage: string) => {
		const validLanguage = SUPPORTED_LANGUAGES.find(
			(lang) => lang === selectedLanguage,
		);
		if (!validLanguage) return;

		// Persist the choice so it survives the reload and future sessions.
		storeLanguage(validLanguage);

		let newPathname = pathname;

		SUPPORTED_LANGUAGES.forEach((lang) => {
			if (newPathname.startsWith(`/${lang}/`)) {
				newPathname = newPathname.replace(`/${lang}`, "");
			} else if (newPathname === `/${lang}`) {
				newPathname = "/";
			}
		});

		window.location.href = `/${validLanguage}${newPathname}${search}${hash}`;
	};

	const handleChange = (value: string | null) => {
		if (!value || value === currentLanguage) return;

		const isInChat = pathname.includes("/chats/");
		if (isInChat) {
			setPendingLanguage(value);
			return;
		}

		applyLanguageChange(value);
	};

	return (
		<>
			<Box onMouseDown={(e) => e.stopPropagation()}>
				<Select
					value={currentLanguage}
					onChange={handleChange}
					data={languageOptions}
					allowDeselect={false}
					withCheckIcon={false}
					comboboxProps={{ offset: 2 }}
					classNames={{ option: classes.option }}
					styles={{
						dropdown: {
							border: "1px solid var(--mantine-color-dark-9)",
						},
						option: {
							paddingBlock: 4,
						},
					}}
					renderOption={({ option }) => (
						<Group gap="xs" wrap="nowrap">
							<span>{option.label}</span>
							{PARTIAL_LANGUAGES.has(option.value) && (
								<span className={classes.partial}>(Partial)</span>
							)}
						</Group>
					)}
					{...testId("header-language-picker")}
				/>
			</Box>

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
