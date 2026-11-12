import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Checkbox,
	Group,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { memo } from "react";
import { Controller } from "react-hook-form";
import { FormLabel } from "@/components/form/FormLabel";
import { useProjectById } from "@/components/project/hooks";
import { ProjectTagsInput } from "@/components/project/ProjectTagsInput";
import { testId } from "@/lib/testUtils";
import { NAME_LABEL_MAX } from "../portalForm";
import { onOff, type SectionContent, type SectionProps } from "./types";

const MemoizedProjectTagsInput = memo(ProjectTagsInput);

/**
 * About: what the start screen asks (a name, its box's label, tags), the automatic titles,
 * and asking for email on the thank-you page behind its feature flag.
 */
export const useAboutOptions = ({
	project,
	page,
	readOnly,
}: SectionProps): SectionContent => {
	const { control, formState } = page.form;
	const v = page.values;
	const tagsQuery = useProjectById({
		projectId: project.id,
		query: {
			deep: { tags: { _sort: "sort" } },
			fields: ["id", { tags: ["id", "text", "sort"] }],
		},
	});
	const tags = (tagsQuery.data?.tags ?? []) as ProjectTag[];
	const nothing = t`Nothing yet`;
	return {
		options: {
			"ask-email": {
				body: (
					<Controller
						name="default_conversation_ask_for_participant_email"
						control={control}
						render={({ field }) => (
							<Checkbox
								label={
									<FormLabel
										label={t`Ask for email?`}
										isDirty={
											formState.dirtyFields
												.default_conversation_ask_for_participant_email
										}
										error={
											formState.errors
												.default_conversation_ask_for_participant_email?.message
										}
									/>
								}
								description={
									<Trans>Optional field on the thank you page</Trans>
								}
								checked={field.value}
								onChange={(e) => field.onChange(e.currentTarget.checked)}
								{...testId("portal-editor-ask-email-checkbox")}
							/>
						)}
					/>
				),
				summary: onOff(
					v.default_conversation_ask_for_participant_email,
					t`Asked`,
					t`Not asked`,
				),
				title: t`Ask for email?`,
			},
			"ask-name": {
				body: (
					<Controller
						name="default_conversation_ask_for_participant_name"
						control={control}
						render={({ field }) => (
							<Checkbox
								label={
									<FormLabel
										label={t`Ask for name?`}
										isDirty={
											formState.dirtyFields
												.default_conversation_ask_for_participant_name
										}
										error={
											formState.errors
												.default_conversation_ask_for_participant_name?.message
										}
									/>
								}
								description={<Trans>Optional field on the start page</Trans>}
								checked={field.value}
								onChange={(e) => field.onChange(e.currentTarget.checked)}
								{...testId("portal-editor-ask-name-checkbox")}
							/>
						)}
					/>
				),
				summary: onOff(
					v.default_conversation_ask_for_participant_name,
					t`Asked`,
					t`Not asked`,
				),
				title: t`Ask for name?`,
			},
			"auto-titles": {
				body: (
					<Stack gap="md">
						<Group gap="xs">
							<Badge color="mauve" c="graphite" size="sm">
								<Trans>Beta</Trans>
							</Badge>
						</Group>
						<Text size="sm" c="dimmed">
							<Trans>
								Automatically generate a short topic-based title for each
								conversation after summarization. The title describes what was
								discussed, not who participated. The participant's original name
								is preserved separately, if they provided one.
							</Trans>
						</Text>
						<Controller
							name="enable_ai_title_and_tags"
							control={control}
							render={({ field }) => (
								<Switch
									label={
										<FormLabel
											label={t`Auto-generate titles`}
											isDirty={formState.dirtyFields.enable_ai_title_and_tags}
											error={formState.errors.enable_ai_title_and_tags?.message}
										/>
									}
									checked={field.value}
									onChange={(e) => field.onChange(e.currentTarget.checked)}
									{...testId("portal-editor-auto-titles-switch")}
								/>
							)}
						/>
					</Stack>
				),
				summary: onOff(v.enable_ai_title_and_tags, t`On`, t`Off`),
				title: t`Auto-generate titles`,
			},
			"name-label": {
				body: (
					<Controller
						name="conversation_ask_for_participant_name_label"
						control={control}
						render={({ field }) => (
							<TextInput
								label={
									<FormLabel
										label={t`What the name box asks for`}
										isDirty={
											formState.dirtyFields
												.conversation_ask_for_participant_name_label
										}
										error={
											formState.errors
												.conversation_ask_for_participant_name_label?.message
										}
									/>
								}
								description={t`Participants read this above the box, for example "Table name or number". Leave it empty for the default.`}
								placeholder={t`Session name`}
								maxLength={NAME_LABEL_MAX}
								error={
									formState.errors.conversation_ask_for_participant_name_label
										? t`Keep it to ${NAME_LABEL_MAX} characters.`
										: undefined
								}
								{...field}
								readOnly={readOnly}
								{...testId("portal-editor-name-label-input")}
							/>
						)}
					/>
				),
				summary:
					v.conversation_ask_for_participant_name_label?.trim() ||
					t`Session name`,
				title: t`What the name box asks for`,
			},
			tags: {
				body: <MemoizedProjectTagsInput project={project} />,
				summary:
					tags.length > 0 ? tags.map((tag) => tag.text).join(", ") : nothing,
				title: t`Tags`,
			},
			"title-prompt": {
				body: (
					<Controller
						name="conversation_title_prompt"
						control={control}
						render={({ field }) => (
							<Textarea
								label={
									<FormLabel
										label={t`Custom title prompt`}
										isDirty={formState.dirtyFields.conversation_title_prompt}
										error={formState.errors.conversation_title_prompt?.message}
									/>
								}
								description={
									<Trans>
										Guide how titles are generated. Titles describe the topic of
										the conversation, not the participant.
									</Trans>
								}
								placeholder={t`e.g. "Use short noun phrases like 'Urban Green Spaces' or 'Youth Employment'. Avoid generic titles."`}
								autosize
								minRows={2}
								{...field}
								{...testId("portal-editor-title-prompt-textarea")}
							/>
						)}
					/>
				),
				summary: v.conversation_title_prompt?.trim() || t`Default`,
				title: t`Custom title prompt`,
			},
		},
	};
};
