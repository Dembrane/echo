import { t } from "@lingui/core/macro";
import {
	Box,
	InputDescription,
	NativeSelect,
	Stack,
	TextInput,
} from "@mantine/core";
import { memo } from "react";
import { Controller } from "react-hook-form";
import { FormLabel } from "@/components/form/FormLabel";
import { MarkdownWYSIWYG } from "@/components/form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { testId } from "@/lib/testUtils";
import { plainLine, type SectionContent, type SectionProps } from "./types";

const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

export const languageOptions = () => [
	{ label: t`English`, value: "en" },
	{ label: t`Dutch`, value: "nl" },
	{ label: t`German`, value: "de" },
	{ label: t`Spanish`, value: "es" },
	{ label: t`French`, value: "fr" },
	{
		label: t`Italian (only ECHO features, transcription and summaries)`,
		value: "it",
	},
	{
		label: t`Ukrainian (only ECHO features, transcription and summaries)`,
		value: "uk",
	},
	{
		label: t`Czech (only ECHO features, transcription and summaries)`,
		value: "cs",
	},
];

const tutorialOptions = () => [
	{
		label: t`Default - no tutorial (only privacy statements)`,
		value: "none",
	},
	{ label: t`Basic (essential tutorial slides)`, value: "basic" },
	{ label: t`Advanced (tips and best practices)`, value: "advanced" },
];

/** Welcome: the portal's language, its title and text, and the tutorial cards. */
export const useWelcomeOptions = ({
	page,
	readOnly,
}: SectionProps): SectionContent => {
	const { control, formState } = page.form;
	const v = page.values;
	const languages = languageOptions();
	const tutorials = tutorialOptions();
	const nothing = t`Nothing yet`;
	return {
		options: {
			description: {
				body: (
					<Stack gap="xs">
						<FormLabel
							label={t`Page content`}
							isDirty={formState.dirtyFields.default_conversation_description}
							error={formState.errors.default_conversation_description?.message}
						/>
						<InputDescription>
							{t`This page is shown to participants when they start a conversation after they successfully complete the tutorial.`}
						</InputDescription>
						<Controller
							name="default_conversation_description"
							control={control}
							render={({ field }) => (
								<Box {...testId("portal-editor-page-content-editor")}>
									<MemoizedMarkdownWYSIWYG
										markdown={field.value}
										onChange={field.onChange}
										readOnly={readOnly}
									/>
								</Box>
							)}
						/>
					</Stack>
				),
				summary: plainLine(v.default_conversation_description ?? "") || nothing,
				title: t`Page content`,
			},
			language: {
				body: (
					<Controller
						name="language"
						control={control}
						render={({ field }) => (
							<NativeSelect
								label={
									<FormLabel
										label={t`Language`}
										isDirty={formState.dirtyFields.language}
										error={formState.errors.language?.message}
									/>
								}
								description={t`This language will be used for the participant portal.`}
								data={languages}
								{...field}
								{...testId("portal-editor-language-select")}
							/>
						)}
					/>
				),
				summary:
					languages.find((l) => l.value === v.language)?.label ?? v.language,
				title: t`Language`,
			},
			title: {
				body: (
					<Controller
						name="default_conversation_title"
						control={control}
						render={({ field }) => (
							<TextInput
								label={
									<FormLabel
										label={t`Page title`}
										isDirty={formState.dirtyFields.default_conversation_title}
										error={formState.errors.default_conversation_title?.message}
									/>
								}
								description={t`This title is shown to participants when they start a conversation`}
								{...field}
								{...testId("portal-editor-page-title-input")}
							/>
						)}
					/>
				),
				summary: v.default_conversation_title?.trim() || nothing,
				title: t`Page title`,
			},
			tutorial: {
				body: (
					<Controller
						name="default_conversation_tutorial_slug"
						control={control}
						render={({ field }) => (
							<NativeSelect
								label={
									<FormLabel
										label={t`Select tutorial`}
										isDirty={
											formState.dirtyFields.default_conversation_tutorial_slug
										}
										error={
											formState.errors.default_conversation_tutorial_slug
												?.message
										}
									/>
								}
								description={t`Select the instructions that will be shown to participants when they start a conversation`}
								data={tutorials}
								{...field}
								{...testId("portal-editor-tutorial-select")}
							/>
						)}
					/>
				),
				summary:
					tutorials.find(
						(o) => o.value === v.default_conversation_tutorial_slug,
					)?.label ?? "",
				title: t`Tutorial cards`,
			},
		},
	};
};
