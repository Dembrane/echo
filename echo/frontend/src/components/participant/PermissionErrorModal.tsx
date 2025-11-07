import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Divider, Modal, Stack } from "@mantine/core";
import { IconQuestionMark, IconReload } from "@tabler/icons-react";
import { useState } from "react";
import { checkPermissionError } from "@/lib/utils";

type PermissionErrorModalProps = {
	permissionError: string | null | undefined;
};

export const PermissionErrorModal = ({
	permissionError,
}: PermissionErrorModalProps) => {
	const [troubleShootingGuideOpened, setTroubleShootingGuideOpened] =
		useState(false);

	const handleCheckMicrophoneAccess = async () => {
		const permissionState = await checkPermissionError();
		if (["granted", "prompt"].includes(permissionState ?? "")) {
			window.location.reload();
		} else {
			alert(
				t`Microphone access is still denied. Please check your settings and try again.`,
			);
		}
	};

	return (
		<Modal
			opened={!!permissionError}
			onClose={() => true}
			centered
			fullScreen
			radius={0}
			transitionProps={{ duration: 200, transition: "fade" }}
			withCloseButton={false}
		>
			<div className="h-full rounded-md bg-white py-4">
				<Stack className="container mx-auto mt-4 max-w-2xl px-2" gap="lg">
					<div className="max-w-prose text-lg">
						<Trans id="participant.alert.microphone.access.failure">
							Oops! It looks like microphone access was denied. No worries,
							though! We've got a handy troubleshooting guide for you. Feel free
							to check it out. Once you've resolved the issue, come back and
							visit this page again to check if your microphone is ready.
						</Trans>
					</div>

					<Button
						component="a"
						href="https://dembrane.notion.site/Troubleshooting-Microphone-Permissions-All-Languages-bd340257647742cd9cd960f94c4223bb?pvs=74"
						target="_blank"
						size={troubleShootingGuideOpened ? "lg" : "xl"}
						leftSection={<IconQuestionMark />}
						variant={!troubleShootingGuideOpened ? "filled" : "light"}
						onClick={() => setTroubleShootingGuideOpened(true)}
					>
						<Trans id="participant.button.open.troubleshooting.guide">
							Open troubleshooting guide
						</Trans>
					</Button>
					<Divider />
					<Button
						size={!troubleShootingGuideOpened ? "lg" : "xl"}
						leftSection={<IconReload />}
						variant={troubleShootingGuideOpened ? "filled" : "light"}
						onClick={handleCheckMicrophoneAccess}
					>
						<Trans id="participant.button.check.microphone.access">
							Check microphone access
						</Trans>
					</Button>
				</Stack>
			</div>
		</Modal>
	);
};
