import { Trans } from "@lingui/react/macro";
import { Stack, Title } from "@mantine/core";
import { ChatCircleDotsIcon, SealCheckIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useParticipantProjectById } from "@/portal/hooks";
import { RefineChoice } from "./RefineChoice";
import { refineMode } from "./refineMode";
import { useRefineActions } from "./useRefineActions";

/**
 * The choice between Verify and Explore (ECHO-1052). The recorder's button leads here when
 * both are on, or when the one that is on is locked (cooling down, or AI not available), so
 * the participant sees why.
 */
export const RefineSelection = () => {
	const { projectId, conversationId } = useParams();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const aiUnavailable = projectQuery.data?.is_ai_available === false;
	const actions = useRefineActions({
		aiUnavailable,
		conversationId,
		projectId,
	});

	// If still loading, return null to avoid flicker
	if (projectQuery.isLoading) return null;
	const mode = refineMode(projectQuery.data);
	if (!mode) return null;
	const showVerify = mode !== "explore";
	const showExplore = mode !== "verify";

	return (
		<Stack gap="md" className="h-full justify-center py-6">
			{mode === "both" && (
				<Title order={2}>
					<Trans id="participant.refine.choice.title">
						What would help now?
					</Trans>
				</Title>
			)}
			{showVerify && (
				<RefineChoice
					icon={SealCheckIcon}
					label={<Trans id="participant.echo.verify">Verify</Trans>}
					description={
						<Trans id="participant.refine.verify.line">
							Check what we captured together
						</Trans>
					}
					onPress={actions.goVerify}
					locked={actions.verifyLocked}
					aiUnavailable={aiUnavailable}
					cooldown={{
						isActive: actions.cooldown.verify.isActive,
						progress: actions.cooldown.verify.progress,
						text: (
							<Trans id="participant.refine.cooling.down">
								Cooling down. Available in{" "}
								{actions.cooldown.verify.formattedTime}
							</Trans>
						),
					}}
					testId="portal-echo-verify-card"
				/>
			)}
			{showExplore && (
				<RefineChoice
					icon={ChatCircleDotsIcon}
					label={<Trans id="participant.echo.explore">Explore</Trans>}
					description={
						<Trans id="participant.refine.explore.line">
							Get a question to go deeper
						</Trans>
					}
					onPress={actions.goExplore}
					locked={actions.exploreLocked}
					aiUnavailable={aiUnavailable}
					cooldown={{
						isActive: actions.cooldown.echo.isActive,
						progress: actions.cooldown.echo.progress,
						text: (
							<Trans id="participant.refine.cooling.down">
								Cooling down. Available in {actions.cooldown.echo.formattedTime}
							</Trans>
						),
					}}
					testId="portal-echo-explore-card"
				/>
			)}
		</Stack>
	);
};
