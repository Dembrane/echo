import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, InputDescription, Stack, Switch, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { memo } from "react";
import { Controller } from "react-hook-form";
import { FormLabel } from "@/components/form/FormLabel";
import { MarkdownWYSIWYG } from "@/components/form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { FeatureGatePopover } from "@/components/workspace/FeatureGatePopover";
import { useWorkspace } from "@/hooks/useWorkspace";
import { testId } from "@/lib/testUtils";
import type { Tier } from "@/lib/tiers";
import {
	onOff,
	plainLine,
	type SectionContent,
	type SectionProps,
} from "./types";

const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

/** Finish: the thank-you text, report notifications and the dembrane event invitation. */
export const useFinishOptions = ({
	project,
	page,
	readOnly,
}: SectionProps): SectionContent => {
	const { control, formState } = page.form;
	const v = page.values;
	// The event invitation switch is a paid-plan control. On the free tier it stays on and
	// opens the upgrade path instead of toggling, the way the custom logo does.
	const { workspace } = useWorkspace();
	const eventCtaLocked = workspace?.tier === "free";
	const canRequestUpgrade =
		workspace?.role === "owner" ||
		workspace?.role === "admin" ||
		workspace?.role === "billing";
	const [upgradeOpened, upgrade] = useDisclosure(false);
	const emailOn = v.default_conversation_ask_for_participant_email;

	return {
		extra: (
			<UpgradeModal
				opened={upgradeOpened}
				onClose={upgrade.close}
				currentTier={(workspace?.tier ?? "free") as Tier}
				requiredTier="changemaker"
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspace?.id ?? ""}
				wallKey="event_cta"
				entry="popover_link"
				projectId={project.id}
			/>
		),
		options: {
			event: {
				body: (
					<Stack gap="xs" {...testId("portal-editor-event-cta-section")}>
						<FormLabel
							label={t`dembrane event invitation`}
							isDirty={formState.dirtyFields.is_dembrane_event_cta_enabled}
							error={formState.errors.is_dembrane_event_cta_enabled?.message}
						/>
						<InputDescription>
							<Trans>
								The thank you page ends on a card inviting participants to run
								their own event with dembrane.
							</Trans>
						</InputDescription>
						{eventCtaLocked ? (
							<FeatureGatePopover
								canRequestUpgrade={canRequestUpgrade}
								onStart={upgrade.open}
								requiredTier="changemaker"
								wallKey="event_cta"
								workspaceId={workspace?.id}
							>
								{({ onClick }) => (
									<Switch
										label={t`Show the invitation`}
										description={t`Switching it off comes with a paid plan.`}
										checked
										readOnly
										onClick={(e) => {
											e.preventDefault();
											onClick();
										}}
										{...testId("portal-editor-event-cta-switch")}
									/>
								)}
							</FeatureGatePopover>
						) : (
							<Controller
								name="is_dembrane_event_cta_enabled"
								control={control}
								render={({ field }) => (
									<Switch
										label={t`Show the invitation`}
										checked={field.value}
										onChange={(e) => field.onChange(e.currentTarget.checked)}
										{...testId("portal-editor-event-cta-switch")}
									/>
								)}
							/>
						)}
					</Stack>
				),
				summary: onOff(
					eventCtaLocked || v.is_dembrane_event_cta_enabled,
					t`Shown`,
					t`Hidden`,
				),
				title: t`dembrane event invitation`,
			},
			notifications: {
				body: (
					<Stack gap="md" {...testId("portal-editor-report-notifications")}>
						<Text size="sm" c="dimmed">
							<Trans>Notify participants when a report is published.</Trans>
						</Text>
						{emailOn ? (
							<Controller
								name="is_project_notification_subscription_allowed"
								control={control}
								render={({ field }) => (
									<Switch
										label={
											<FormLabel
												label={t`Enable report notifications`}
												isDirty={
													formState.dirtyFields
														.is_project_notification_subscription_allowed
												}
												error={
													formState.errors
														.is_project_notification_subscription_allowed
														?.message
												}
											/>
										}
										checked={field.value}
										onChange={(e) => field.onChange(e.currentTarget.checked)}
										{...testId("portal-editor-report-notifications-switch")}
									/>
								)}
							/>
						) : (
							<Text size="sm" c="dimmed">
								{t`Requires "Ask for email?" to be enabled`}
							</Text>
						)}
					</Stack>
				),
				summary: emailOn
					? onOff(v.is_project_notification_subscription_allowed, t`On`, t`Off`)
					: t`Requires "Ask for email?" to be enabled`,
				title: t`Report notifications`,
			},
			text: {
				body: (
					<Stack gap="xs">
						<FormLabel
							label={t`Thank you page content`}
							isDirty={formState.dirtyFields.default_conversation_finish_text}
							error={formState.errors.default_conversation_finish_text?.message}
						/>
						<InputDescription>
							<Trans>
								This page is shown after the participant has completed the
								conversation.
							</Trans>
						</InputDescription>
						<Controller
							name="default_conversation_finish_text"
							control={control}
							render={({ field }) => (
								<Box {...testId("portal-editor-thank-you-content-editor")}>
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
				summary:
					plainLine(v.default_conversation_finish_text ?? "") || t`Default`,
				title: t`Thank you page content`,
			},
		},
	};
};
