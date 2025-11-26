import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Box, Button, Group } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconArrowLeft, IconSettings } from "@tabler/icons-react";
import { useLocation, useParams, useSearchParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Logo } from "../common/Logo";
import { ParticipantSettingsModal } from "../participant/ParticipantSettingsModal";

export const ParticipantHeader = () => {
	const [loadingFinished] = useSessionStorageState("loadingFinished", {
		defaultValue: true,
	});
	const { pathname } = useLocation();
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [opened, { open, close }] = useDisclosure(false);
	const [searchParams] = useSearchParams();

	const showInstructions = searchParams.get("instructions") === "true";
	const showBackButton =
		(pathname.includes("/verify") || pathname.includes("/refine")) &&
		!pathname.includes("/verify/approve") &&
		!showInstructions;
	const showCancelButton =
		pathname.includes("/verify") &&
		!pathname.includes("/verify/approve") &&
		showInstructions;
	const hideSettingsButton =
		pathname.includes("start") || pathname.includes("finish");

	if (!loadingFinished) {
		return null;
	}

	const handleBack = () => {
		if (projectId && conversationId) {
			navigate(`/${projectId}/conversation/${conversationId}`);
		}
	};

	const handleCancel = () => {
		if (projectId && conversationId) {
			navigate(`/${projectId}/conversation/${conversationId}`);
		}
	};

	return (
		<>
			<ParticipantSettingsModal opened={opened} onClose={close} />
			<Group
				component="header"
				justify="center"
				className="relative py-2 shadow-sm"
			>
				{showBackButton && (
					<Box className="absolute left-4 top-1/2 -translate-y-1/2">
						<Button
							size="md"
							variant="light"
							leftSection={<IconArrowLeft size={16} />}
							className="rounded-full"
							onClick={handleBack}
						>
							<Trans id="participant.button.back">Back</Trans>
						</Button>
					</Box>
				)}
				{showCancelButton && (
					<Box className="absolute left-4 top-1/2 -translate-y-1/2">
						<Button
							size="md"
							variant="light"
							className="rounded-full"
							onClick={handleCancel}
						>
							<Trans id="participant.concrete.instructions.button.cancel">
								Cancel
							</Trans>
						</Button>
					</Box>
				)}
				<Logo hideTitle h="64px" />
			</Group>
			{!hideSettingsButton && (
				<Box className="absolute right-4 top-5 z-20">
					<ActionIcon
						size="lg"
						variant="transparent"
						onClick={open}
						title={t`Settings`}
						aria-label={t`Settings`}
					>
						<IconSettings size={24} color="gray" />
					</ActionIcon>
				</Box>
			)}
		</>
	);
};
