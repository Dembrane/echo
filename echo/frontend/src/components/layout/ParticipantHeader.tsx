import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Box, Button, Group } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { GearSixIcon } from "@phosphor-icons/react";
import { IconArrowLeft, IconShare2 } from "@tabler/icons-react";
import { useLocation, useParams, useSearchParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";
import { Logo } from "../common/Logo";
import { useParticipantProjectById } from "../participant/hooks";
import { ParticipantSettingsModal } from "../participant/ParticipantSettingsModal";
import { ParticipantShareModal } from "../participant/ParticipantShareModal";

export const ParticipantHeader = () => {
	const [loadingFinished] = useSessionStorageState("loadingFinished", {
		defaultValue: true,
	});
	const { pathname } = useLocation();
	const { projectId, conversationId } = useParams();
	const navigate = useI18nNavigate();
	const [settingsOpened, { open: openSettings, close: closeSettings }] =
		useDisclosure(false);
	const [shareOpened, { open: openShare, close: closeShare }] =
		useDisclosure(false);
	const [searchParams] = useSearchParams();
	const projectQuery = useParticipantProjectById(projectId ?? "");

	const showInstructions = searchParams.get("instructions") === "true";
	const showBackButton =
		(pathname.includes("/verify") || pathname.includes("/refine")) &&
		!pathname.includes("/verify/approve") &&
		!showInstructions;
	const showCancelButton =
		pathname.includes("/verify") &&
		!pathname.includes("/verify/approve") &&
		showInstructions;
	const hideHeaderActions =
		pathname.includes("start") || pathname.includes("finish");
	const hideHeader = pathname.includes("start");

	if (!loadingFinished || hideHeader) {
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
			<ParticipantSettingsModal
				opened={settingsOpened}
				onClose={closeSettings}
			/>
			<ParticipantShareModal
				opened={shareOpened}
				onClose={closeShare}
				project={projectQuery.data}
			/>
			<Group
				component="header"
				justify="center"
				className="relative py-2 shadow-sm"
				{...testId("portal-header")}
			>
				{showBackButton && (
					<Box className="absolute left-4 top-1/2 -translate-y-1/2">
						<Button
							size="md"
							variant="subtle"
							leftSection={<IconArrowLeft size={16} />}
							onClick={handleBack}
							{...testId("portal-header-back-button")}
						>
							<Trans id="participant.button.back">Back</Trans>
						</Button>
					</Box>
				)}
				{showCancelButton && (
					<Box className="absolute left-4 top-1/2 -translate-y-1/2">
						<Button
							size="md"
							variant="subtle"
							onClick={handleCancel}
							{...testId("portal-header-cancel-button")}
						>
							<Trans id="participant.concrete.instructions.button.cancel">
								Cancel
							</Trans>
						</Button>
					</Box>
				)}
				<Logo hideTitle h="64px" />
			</Group>
			{!hideHeaderActions && (
				<Group className="absolute right-4 top-5 z-20" gap="xs" wrap="nowrap">
					<ActionIcon
						size="lg"
						variant="transparent"
						onClick={openSettings}
						title={t`Settings`}
						aria-label={t`Settings`}
						{...testId("portal-header-settings-button")}
					>
						<GearSixIcon size={24} color="gray" />
					</ActionIcon>
					<ActionIcon
						size="lg"
						variant="transparent"
						onClick={openShare}
						title={t`Share portal`}
						aria-label={t`Share portal`}
						{...testId("portal-header-share-button")}
					>
						<IconShare2 size={24} color="gray" />
					</ActionIcon>
				</Group>
			)}
		</>
	);
};
