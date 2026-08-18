import { Trans } from "@lingui/react/macro";
import { useDisclosure } from "@mantine/hooks";
import {
	ChatCircle,
	EnvelopeSimple,
	Note,
	Pulse,
	Sparkle,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { FeedbackPortalModal } from "@/components/common/FeedbackPortalModal";
import { ReleaseVideoModal } from "@/components/release/ReleaseVideoModal";
import { ENABLE_RELEASE_VIDEO_MODAL, getDocumentationUrl } from "@/config";
import { NavButton } from "../primitives/NavButton";
import { SectionLabel } from "../primitives/SectionLabel";

export const HelpBlock = () => {
	const { language } = useParams();
	const [feedbackOpen, feedback] = useDisclosure(false);
	// The release modal lives here so the button that reopens it can hold its
	// own state. It also shows itself once per release without being asked.
	const [releaseRequested, release] = useDisclosure(false);
	const docUrl = getDocumentationUrl(language);

	return (
		<>
			<div className="flex flex-col gap-0.5">
				<SectionLabel>
					<Trans>Help</Trans>
				</SectionLabel>
				<NavButton
					label={<Trans>Feedback</Trans>}
					icon={ChatCircle}
					iconColor="var(--mantine-color-primary-6)"
					labelColor="var(--mantine-color-primary-6)"
					onClick={feedback.open}
				/>
				{ENABLE_RELEASE_VIDEO_MODAL ? (
					<NavButton
						label={<Trans>What's new</Trans>}
						icon={Sparkle}
						onClick={release.open}
					/>
				) : null}
				<NavButton
					label={<Trans>Documentation</Trans>}
					icon={Note}
					external
					onClick={() => window.open(docUrl, "_blank", "noopener,noreferrer")}
				/>
				<NavButton
					label={<Trans>System status</Trans>}
					icon={Pulse}
					onClick={() => undefined}
					badge={<Trans>Planned</Trans>}
					disabled
				/>
				<NavButton
					label={<Trans>Contact support</Trans>}
					icon={EnvelopeSimple}
					external
					onClick={() => {
						window.location.href = "mailto:support@dembrane.com";
					}}
				/>
			</div>
			<FeedbackPortalModal
				opened={feedbackOpen}
				onClose={feedback.close}
				locale={language}
			/>
			{ENABLE_RELEASE_VIDEO_MODAL ? (
				<ReleaseVideoModal
					requested={releaseRequested}
					onRequestedClose={release.close}
				/>
			) : null}
		</>
	);
};
