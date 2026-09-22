import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { MultiSelect, Paper, Select, Stack, Title } from "@mantine/core";
import {
	type PopcornDetail,
	type PopcornLanguage,
	type PopcornLanguageCode,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { FIELD_SIZE } from "@/components/popcorn/PopcornVoiceSection";
import type { TranslationStatus as TranslationStatusValue } from "@/components/present/hooks";
import { TranslationStatus } from "@/components/present/TranslationStatus";
import { testId } from "@/lib/testUtils";

// Each language in its own name, so a host finds theirs whatever the
// dashboard is set to.
const LANGUAGES: { value: PopcornLanguageCode; label: string }[] = [
	{ label: "English", value: "en" },
	{ label: "Nederlands", value: "nl" },
	{ label: "Deutsch", value: "de" },
	{ label: "Français", value: "fr" },
	{ label: "Español", value: "es" },
	{ label: "Italiano", value: "it" },
	{ label: "Українська", value: "uk" },
	{ label: "Čeština", value: "cs" },
];

const DEFAULT_LANGUAGE: PopcornLanguage = { translate_to: "", ui: "auto" };

// Three on top of the one the whole screen is translated into. More than that
// and a single phrase holds the wall for a minute.
const ALSO_MAX = 3;

const asLanguageCodes = (values: string[]): PopcornLanguageCode[] =>
	values.filter((value): value is PopcornLanguageCode =>
		LANGUAGES.some((option) => option.value === value),
	);

/**
 * The extra languages the popcorn phrases pop in. Separate from the card
 * because the Present editor also offers it under "Follow project language",
 * where the primary target comes from the project rather than from these
 * settings: pass that language in and the list still writes here.
 */
export function PopcornAlsoLanguages({
	projectId,
	popcorn,
	language,
}: {
	projectId: string;
	popcorn: PopcornDetail;
	// The language the screen is translated into, when it is not the one held
	// in this presentation's own settings.
	language?: PopcornLanguage;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	// `also` is only ever written to these settings, so they are its source
	// whichever language policy is in force.
	const stored = popcorn.settings.language ?? DEFAULT_LANGUAGE;
	const primary = (language ?? stored).translate_to;
	// A host who translates nothing has nothing to stack extra languages on.
	if (!primary) return null;
	// The source language the phrases were spoken in is not known here, so
	// every language but the primary target stays on offer.
	return (
		<MultiSelect
			size={FIELD_SIZE}
			label={t`Popcorn also in`}
			description={t`Each popcorn pops once per language: the original first, then these in random order.`}
			data={LANGUAGES.filter(({ value }) => value !== primary)}
			value={(stored.also ?? []).filter((code) => code !== primary)}
			maxValues={ALSO_MAX}
			clearable
			searchable={false}
			disabled={settings.isPending}
			onChange={(value) =>
				settings.mutate({ language: { also: asLanguageCodes(value) } })
			}
			{...testId("popcorn-language-also")}
		/>
	);
}

// Like the Screen card, each choice lands on the wall at its next poll. A new
// translation language also starts a read, which translates the results.
export function PopcornLanguageSettings({
	projectId,
	popcorn,
	embedded = false,
}: {
	projectId: string;
	popcorn: PopcornDetail & { translation_status?: TranslationStatusValue };
	embedded?: boolean;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const language = popcorn.settings.language ?? DEFAULT_LANGUAGE;

	return (
		<Paper
			withBorder={!embedded}
			className="rounded-md"
			p={embedded ? 0 : "lg"}
			{...testId("popcorn-language")}
		>
			<Stack gap="md">
				{!embedded && (
					<Title order={4}>
						<Trans>Language</Trans>
					</Title>
				)}
				<Select
					size={FIELD_SIZE}
					label={t`Screen language`}
					description={t`The words around the results: tabs, buttons and explanations.`}
					data={[
						{ label: t`Automatic (project language)`, value: "auto" },
						...LANGUAGES,
					]}
					value={language.ui}
					allowDeselect={false}
					disabled={settings.isPending}
					onChange={(value) =>
						value &&
						settings.mutate({
							language: { ui: value as PopcornLanguage["ui"] },
						})
					}
					{...testId("popcorn-language-ui")}
				/>
				<Select
					size={FIELD_SIZE}
					label={t`Results`}
					description={t`Results show in the language people spoke. Choose a language to translate every popcorn, quote, tension and stakeholder for this presentation; the originals are kept.`}
					data={[
						{ label: t`Original language`, value: "" },
						...LANGUAGES.map(({ label: name, value }) => ({
							label: t`Translate to ${name}`,
							value,
						})),
					]}
					value={language.translate_to}
					allowDeselect={false}
					disabled={settings.isPending}
					onChange={(value) => {
						if (value === null) return;
						const target = value as PopcornLanguage["translate_to"];
						const also = language.also ?? [];
						// A language cannot be both the one everything is translated
						// into and an extra the phrases pop in: drop it in the same
						// save, so the room never hears the same phrase twice.
						const kept = also.filter((code) => code !== target);
						settings.mutate({
							language: {
								translate_to: target,
								...(kept.length === also.length ? {} : { also: kept }),
							},
						});
					}}
					{...testId("popcorn-language-translate")}
				/>
				<PopcornAlsoLanguages projectId={projectId} popcorn={popcorn} />
				{embedded && (
					<TranslationStatus
						presentationId={popcorn.id}
						status={popcorn.translation_status}
					/>
				)}
			</Stack>
		</Paper>
	);
}
