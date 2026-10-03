import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Box, Button, Group } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { GearSixIcon, ArrowLeftIcon, QrCodeIcon } from "@phosphor-icons/react";
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
			{/* The rule runs edge to edge; the contents keep to the same column
			    as the page below, so on a wide screen the logo and the actions
			    line up with the text rather than the window. */}
			<Box
				component="header"
				className="border-b"
				style={{ borderColor: "var(--app-rule-color)" }}
			>
				<Group
					justify="space-between"
					wrap="nowrap"
					className="container relative mx-auto max-w-2xl px-4 py-2"
					{...testId("portal-header")}
				>
					<Box className="min-w-0">
						{showBackButton ? (
							<Button
								size="md"
								variant="subtle"
								color="gray"
								px={0}
								leftSection={<ArrowLeftIcon size={20} />}
								onClick={handleBack}
								{...testId("portal-header-back-button")}
							>
								<Trans id="participant.button.back">Back</Trans>
							</Button>
						) : showCancelButton ? (
							<Button
								size="md"
								variant="subtle"
								color="gray"
								px={0}
								onClick={handleCancel}
								{...testId("portal-header-cancel-button")}
							>
								<Trans id="participant.concrete.instructions.button.cancel">
									Cancel
								</Trans>
							</Button>
						) : (
							<Logo h="36px" />
						)}
					</Box>
					{!hideHeaderActions && (
						<Group gap="lg" wrap="nowrap">
							<ActionIcon
								onClick={openShare}
								title={t`Share portal`}
								aria-label={t`Share portal`}
								{...testId("portal-header-share-button")}
							>
								<QrCodeIcon size={20} />
							</ActionIcon>
							<ActionIcon
								onClick={openSettings}
								title={t`Settings`}
								aria-label={t`Settings`}
								{...testId("portal-header-settings-button")}
							>
								<GearSixIcon size={20} />
							</ActionIcon>
						</Group>
					)}
				</Group>
			</Box>
		</>
	);
};
