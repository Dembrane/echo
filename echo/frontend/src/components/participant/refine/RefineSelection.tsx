import { Trans } from "@lingui/react/macro";
import { Box, Group, Progress, Stack, Text, Title } from "@mantine/core";
import { IconArrowDownToArc, IconMessageFilled } from "@tabler/icons-react";
import { useParams } from "react-router";
import { useParticipantProjectById } from "@/components/participant/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useRefineSelectionCooldown } from "./hooks/useRefineSelectionCooldown";

export const RefineSelection = () => {
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const cooldown = useRefineSelectionCooldown(conversationId);
	const projectQuery = useParticipantProjectById(projectId ?? "");

	const handleVerifyClick = () => {
		if (cooldown.verify.isActive) return;
		navigate(`/${projectId}/conversation/${conversationId}/verify`);
	};

	const handleEchoClick = () => {
		if (cooldown.echo.isActive) return;
		cooldown.startEchoCooldown();
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
			{/* Make it concrete option */}
			{showVerify && (
				<Box
					onClick={handleVerifyClick}
					className={`${flexClass} cursor-pointer rounded-xl border-2 p-6 transition-all ${
						cooldown.verify.isActive
							? "border-gray-200 bg-gray-50"
							: "border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50"
					}`}
					style={{
						cursor: cooldown.verify.isActive ? "not-allowed" : "pointer",
						opacity: cooldown.verify.isActive ? 0.6 : 1,
					}}
				>
					<Stack
						gap="lg"
						align="center"
						className="h-full px-2 py-6 justify-center"
					>
						<Group gap="sm" align="center">
							<IconMessageFilled size={32} />
							<Title order={2} fw={600}>
								<Trans id="participant.refine.make.concrete">
									Make it concrete
								</Trans>
							</Title>
						</Group>
						<Text size="lg" c="dimmed" ta="center">
							<Trans id="participant.refine.make.concrete.description">
								Take some time to create an outcome that makes your contribution
								concrete.
							</Trans>
						</Text>

						{cooldown.verify.isActive && (
							<Stack gap="xs" w="100%">
								<Text size="sm" c="dimmed" fs="italic" ta="center">
									<Trans id="participant.refine.cooling.down">
										Cooling down. Available in {cooldown.verify.formattedTime}
									</Trans>
								</Text>
								<Progress
									value={cooldown.verify.progress}
									size="md"
									radius="xl"
									animated={cooldown.verify.isActive}
								/>
							</Stack>
						)}
					</Stack>
				</Box>
			)}

			{/* Go deeper option */}
			{showEcho && (
				<Box
					onClick={handleEchoClick}
					className={`${flexClass} cursor-pointer rounded-xl border-2 p-6 transition-all ${
						cooldown.echo.isActive
							? "border-gray-200 bg-gray-50"
							: "border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50"
					}`}
					style={{
						cursor: cooldown.echo.isActive ? "not-allowed" : "pointer",
						opacity: cooldown.echo.isActive ? 0.6 : 1,
					}}
				>
					<Stack
						gap="lg"
						align="center"
						className="h-full px-6 py-6 justify-center"
					>
						<Group gap="sm" align="center">
							<IconArrowDownToArc size={32} />
							<Title order={2} fw={600}>
								<Trans id="participant.refine.go.deeper">Go deeper</Trans>
							</Title>
						</Group>
						<Text size="lg" c="dimmed" ta="center">
							<Trans id="participant.refine.go.deeper.description">
								Get an immediate reply from Dembrane to help you deepen the
								conversation.
							</Trans>
						</Text>

						{cooldown.echo.isActive && (
							<Stack gap="xs" w="100%">
								<Text size="sm" c="dimmed" fs="italic" ta="center">
									<Trans id="participant.refine.cooling.down">
										Cooling down. Available in {cooldown.echo.formattedTime}
									</Trans>
								</Text>
								<Progress
									value={cooldown.echo.progress}
									size="md"
									radius="xl"
									animated={cooldown.echo.isActive}
								/>
							</Stack>
						)}
					</Stack>
				</Box>
			)}
		</Stack>
	);
};
