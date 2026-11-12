import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Group,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	Textarea,
} from "@mantine/core";
import { Controller } from "react-hook-form";
import { FormLabel } from "@/components/form/FormLabel";
import { testId } from "@/lib/testUtils";
import { onOff, type SectionContent, type SectionProps } from "./types";

export const exploreModeLabel = (mode: string) =>
	mode === "brainstorm"
		? t`Brainstorm ideas`
		: mode === "custom"
			? t`Custom`
			: t({ id: "dashboard.explore.mode.question", message: "One question" });

/** Explore: on or off, its mode, the custom prompt, and looking at other conversations. */
export const useExploreOptions = ({ page }: SectionProps): SectionContent => {
	const { control, formState } = page.form;
	const v = page.values;
	return {
		options: {
			enabled: {
				body: (
					<Stack gap="md">
						<Group gap="xs">
							<Badge color="mauve" c="graphite" size="sm">
								<Trans id="dashboard.dembrane.concrete.beta">Beta</Trans>
							</Badge>
						</Group>
						<Text size="sm" c="dimmed">
							<Trans>
								Enable this feature to allow participants to request AI-powered
								responses during their conversation. Participants can click
								"Explore" after recording their thoughts to receive contextual
								feedback, encouraging deeper reflection and engagement. A
								cooldown period applies between requests.
							</Trans>
						</Text>
						<Controller
							name="is_get_reply_enabled"
							control={control}
							render={({ field }) => (
								<Switch
									label={
										<FormLabel
											label={t`Enable Explore`}
											isDirty={formState.dirtyFields.is_get_reply_enabled}
											error={formState.errors.is_get_reply_enabled?.message}
										/>
									}
									checked={field.value}
									onChange={(e) => field.onChange(e.currentTarget.checked)}
									{...testId("portal-editor-go-deeper-switch")}
								/>
							)}
						/>
					</Stack>
				),
				summary: onOff(v.is_get_reply_enabled, t`On`, t`Off`),
				title: t`Explore`,
			},
			mode: {
				body: (
					<Controller
						name="get_reply_mode"
						control={control}
						render={({ field }) => (
							<Stack gap="xs">
								<FormLabel
									label={t`Mode`}
									isDirty={formState.dirtyFields.get_reply_mode}
									error={formState.errors.get_reply_mode?.message}
								/>
								<Text size="sm" c="dimmed">
									<Trans>
										Select the type of feedback or engagement you want to
										encourage.
									</Trans>
								</Text>
								<SegmentedControl
									value={field.value}
									onChange={field.onChange}
									style={{ alignSelf: "flex-start" }}
									data={[
										{
											label: (
												<span {...testId("portal-editor-reply-mode-default")}>
													{exploreModeLabel("summarize")}
												</span>
											),
											value: "summarize",
										},
										{
											label: (
												<span
													{...testId("portal-editor-reply-mode-brainstorm")}
												>
													{exploreModeLabel("brainstorm")}
												</span>
											),
											value: "brainstorm",
										},
										{
											label: (
												<span {...testId("portal-editor-reply-mode-custom")}>
													{exploreModeLabel("custom")}
												</span>
											),
											value: "custom",
										},
									]}
								/>
							</Stack>
						)}
					/>
				),
				summary: exploreModeLabel(v.get_reply_mode),
				title: t`Mode`,
			},
			"other-conversations": {
				body: (
					<Controller
						name="is_get_reply_cross_pollination_enabled"
						control={control}
						render={({ field }) => (
							<Switch
								label={
									<FormLabel
										label={t`Cross-pollination`}
										isDirty={
											formState.dirtyFields
												.is_get_reply_cross_pollination_enabled
										}
										error={
											formState.errors.is_get_reply_cross_pollination_enabled
												?.message
										}
									/>
								}
								description={t`Explore may bring in what other groups in this project said. Off: it only looks at this conversation.`}
								checked={field.value}
								onChange={(e) => field.onChange(e.currentTarget.checked)}
								{...testId("portal-editor-cross-pollination-switch")}
							/>
						)}
					/>
				),
				summary: onOff(v.is_get_reply_cross_pollination_enabled, t`On`, t`Off`),
				title: t`Cross-pollination`,
			},
			prompt: {
				body: (
					<Controller
						name="get_reply_prompt"
						control={control}
						render={({ field }) => (
							<Textarea
								label={
									<FormLabel
										label={t`Reply prompt`}
										isDirty={formState.dirtyFields.get_reply_prompt}
										error={formState.errors.get_reply_prompt?.message}
									/>
								}
								description={
									<Box pb="sm">
										<Trans>
											This prompt guides how the AI responds to participants.
											Customize it to shape the type of feedback or engagement
											you want to encourage.
										</Trans>
									</Box>
								}
								autosize
								minRows={5}
								{...field}
								{...testId("portal-editor-reply-prompt-textarea")}
							/>
						)}
					/>
				),
				summary: v.get_reply_prompt?.trim() || t`Nothing yet`,
				title: t`Reply prompt`,
			},
		},
	};
};
