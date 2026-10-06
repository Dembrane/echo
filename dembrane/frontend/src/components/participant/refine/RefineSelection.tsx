import { Trans } from "@lingui/react/macro";
import { Progress, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { useParams } from "react-router";
import { useParticipantProjectById } from "@/components/participant/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";
import { useRefineSelectionCooldown } from "./hooks/useRefineSelectionCooldown";

export const RefineSelection = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const cooldown = useRefineSelectionCooldown(conversationId);
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const [_isRefineDisabled, setIsRefineDisabled] = useLocalStorage({
		defaultValue: false,
		key: `refine_disabled_${conversationId}`,
	});

	const handleVerifyClick = () => {
		if (cooldown.verify.isActive) return;
		navigate(`/${projectId}/conversation/${conversationId}/verify`);
	};

	const handleEchoClick = () => {
		if (cooldown.echo.isActive) return;
		cooldown.startEchoCooldown();
		// Disable refine button while echo is generating
		setIsRefineDisabled(true);
		navigate(`/${projectId}/conversation/${conversationId}?echo=1`);
	};

	const showVerify = projectQuery.data?.is_verify_enabled ?? false;
	const showEcho = projectQuery.data?.is_get_reply_enabled ?? false;

	// If still loading, return null to avoid flicker
	if (projectQuery.isLoading) {
		return null;
	}

	if (!showVerify && !showEcho) {
		return null;
	}

	const flexClass = showVerify && showEcho ? "flex-1" : "h-[50%]";

	return (
		<Stack gap="md" className="h-full">
			{/* Verify option */}
			{showVerify && (
				<UnstyledButton
					onClick={handleVerifyClick}
					className={`${flexClass} app-do block w-full p-6`}
					aria-disabled={cooldown.verify.isActive || undefined}
					style={{
						cursor: cooldown.verify.isActive ? "not-allowed" : "pointer",
						opacity: cooldown.verify.isActive ? 0.6 : 1,
					}}
					{...testId("portal-echo-verify-card")}
				>
					<Stack gap="md" className="h-full py-6 justify-center">
						<Title order={4}>
							<Trans id="participant.echo.verify">Verify</Trans>
						</Title>
						<Text c="dimmed">
							<Trans id="participant.refine.make.concrete.description">
								Take some time to create an outcome that makes your contribution
								concrete.
							</Trans>
						</Text>

						{cooldown.verify.isActive && (
							<Stack gap="xs" w="100%">
								<Text size="sm" c="dimmed">
									<Trans id="participant.refine.cooling.down">
										Cooling down. Available in {cooldown.verify.formattedTime}
									</Trans>
								</Text>
								<Progress
									value={cooldown.verify.progress}
									size="md"
									animated={cooldown.verify.isActive}
								/>
							</Stack>
						)}
					</Stack>
				</UnstyledButton>
			)}

			{/* Explore option */}
			{showEcho && (
				<UnstyledButton
					onClick={handleEchoClick}
					className={`${flexClass} app-do block w-full p-6`}
					aria-disabled={cooldown.echo.isActive || undefined}
					style={{
						cursor: cooldown.echo.isActive ? "not-allowed" : "pointer",
						opacity: cooldown.echo.isActive ? 0.6 : 1,
					}}
					{...testId("portal-echo-explore-card")}
				>
					<Stack gap="md" className="h-full py-6 justify-center">
						<Title order={4}>
							<Trans id="participant.echo.explore">Explore</Trans>
						</Title>
						<Text c="dimmed">
							<Trans id="participant.refine.go.deeper.description">
								Get an immediate reply from dembrane to help you deepen the
								conversation.
							</Trans>
						</Text>

						{cooldown.echo.isActive && (
							<Stack gap="xs" w="100%">
								<Text size="sm" c="dimmed">
									<Trans id="participant.refine.cooling.down">
										Cooling down. Available in {cooldown.echo.formattedTime}
									</Trans>
								</Text>
								<Progress
									value={cooldown.echo.progress}
									size="md"
									animated={cooldown.echo.isActive}
								/>
							</Stack>
						)}
					</Stack>
				</UnstyledButton>
			)}
		</Stack>
	);
};
