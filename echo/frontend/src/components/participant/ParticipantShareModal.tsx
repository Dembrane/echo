import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, CopyButton, Group, Modal, Stack, Text } from "@mantine/core";
import {
	IconBrandWhatsapp,
	IconCheck,
	IconCopy,
	IconMail,
	IconShare2,
} from "@tabler/icons-react";
import posthog from "posthog-js";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Logo } from "@/components/common/Logo";
import { QRCode } from "@/components/common/QRCode";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import { buildPortalSessionSharingLink } from "@/lib/portalSharing";
import { testId } from "@/lib/testUtils";

interface ParticipantShareModalProps {
	opened: boolean;
	onClose: () => void;
	project?: Project;
}

export const ParticipantShareModal = ({
	opened,
	onClose,
	project,
}: ParticipantShareModalProps) => {
	const [searchParams] = useSearchParams();
	const baseLink = useProjectSharingLink(project, "portal");
	const currentSearch = searchParams.toString();
	const shareLink = useMemo(
		() =>
			baseLink
				? buildPortalSessionSharingLink(
						baseLink,
						new URLSearchParams(currentSearch),
					)
				: null,
		[baseLink, currentSearch],
	);

	const trackShare = (method: "copy" | "email" | "native" | "whatsapp") => {
		posthog.capture("portal_share_selected", {
			method,
			project_id: project?.id,
		});
	};

	const handleNativeShare = async () => {
		if (!shareLink || !navigator.share) return;
		trackShare("native");
		try {
			await navigator.share({
				title: t`Join this portal session`,
				url: shareLink,
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") return;
			console.error("Could not open the share menu", error);
		}
	};

	const encodedShareText = shareLink
		? encodeURIComponent(`${t`Join this portal session`}: ${shareLink}`)
		: "";

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			fullScreen
			padding="xl"
			title={<Logo h="36px" />}
			{...testId("portal-share-modal")}
		>
			<Stack align="center" justify="center" gap="lg" mih="calc(100dvh - 7rem)">
				<Text size="lg" ta="center">
					<Trans>Scan to start a new portal session</Trans>
				</Text>

				{shareLink && project?.is_conversation_allowed ? (
					<>
						<QRCode
							value={shareLink}
							className="w-[min(86vw,55dvh)] max-w-2xl sm:w-[min(70vw,62dvh)]"
							{...testId("portal-share-qr-code")}
						/>

						<Group justify="center" gap="sm" wrap="wrap">
							<CopyButton value={shareLink} timeout={2000}>
								{({ copied, copy }) => (
									<Button
										size="lg"
										variant="outline"
										leftSection={copied ? <IconCheck /> : <IconCopy />}
										onClick={() => {
											copy();
											trackShare("copy");
										}}
										{...testId("portal-share-copy-button")}
									>
										{copied ? t`Copied` : t`Copy link`}
									</Button>
								)}
							</CopyButton>
							<Button
								size="lg"
								variant="outline"
								component="a"
								href={`https://wa.me/?text=${encodedShareText}`}
								target="_blank"
								rel="noopener noreferrer"
								leftSection={<IconBrandWhatsapp />}
								onClick={() => trackShare("whatsapp")}
								{...testId("portal-share-whatsapp-button")}
							>
								<Trans>WhatsApp</Trans>
							</Button>
							<Button
								size="lg"
								variant="outline"
								component="a"
								href={`mailto:?subject=${encodeURIComponent(t`Join this portal session`)}&body=${encodedShareText}`}
								leftSection={<IconMail />}
								onClick={() => trackShare("email")}
								{...testId("portal-share-email-button")}
							>
								<Trans>Email</Trans>
							</Button>
							{typeof navigator !== "undefined" && "share" in navigator && (
								<Button
									size="lg"
									variant="outline"
									leftSection={<IconShare2 />}
									onClick={handleNativeShare}
									{...testId("portal-share-native-button")}
								>
									<Trans>More</Trans>
								</Button>
							)}
						</Group>
					</>
				) : (
					<Text ta="center">
						<Trans>This portal is not accepting new sessions right now.</Trans>
					</Text>
				)}
			</Stack>
		</Modal>
	);
};
