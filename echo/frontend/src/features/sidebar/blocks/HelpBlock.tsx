import { Trans } from "@lingui/react/macro";
import { useDisclosure } from "@mantine/hooks";
import {
	Bug,
	ChatCircle,
	EnvelopeSimple,
	Note,
	Pulse,
	Sparkle,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { ReleaseVideoModal } from "@/components/release/ReleaseVideoModal";
import { ENABLE_RELEASE_VIDEO_MODAL, getDocumentationUrl } from "@/config";
import { useHelpModals } from "../hooks/useHelpModals";
import { NavButton } from "../primitives/NavButton";
import { SectionLabel } from "../primitives/SectionLabel";

export const HelpBlock = () => {
	const { language } = useParams();
	const { openFeedback, openReportIssue } = useHelpModals();
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
					label={<Trans>Report an issue</Trans>}
					icon={Bug}
					iconColor="var(--mantine-color-primary-6)"
					labelColor="var(--mantine-color-primary-6)"
					onClick={openReportIssue}
				/>
				<NavButton
					label={<Trans>Feedback</Trans>}
					icon={ChatCircle}
					iconColor="var(--mantine-color-primary-6)"
					labelColor="var(--mantine-color-primary-6)"
					onClick={openFeedback}
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
			{ENABLE_RELEASE_VIDEO_MODAL ? (
				<ReleaseVideoModal
					requested={releaseRequested}
					onRequestedClose={release.close}
				/>
			) : null}
		</>
	);
};
