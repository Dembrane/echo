import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Paper, Select, Stack, Title } from "@mantine/core";
import {
	type PopcornDetail,
	type PopcornLanguage,
	type PopcornLanguageCode,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { FIELD_SIZE } from "@/components/popcorn/PopcornVoiceSection";
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

// Like the Screen card, each choice lands on the wall at its next poll. A new
// translation language also starts a read, which translates the results.
export function PopcornLanguageSettings({
	projectId,
	popcorn,
	embedded = false,
}: {
	projectId: string;
	popcorn: PopcornDetail;
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
					onChange={(value) =>
						value !== null &&
						settings.mutate({
							language: {
								translate_to: value as PopcornLanguage["translate_to"],
							},
						})
					}
					{...testId("popcorn-language-translate")}
				/>
			</Stack>
		</Paper>
	);
}
