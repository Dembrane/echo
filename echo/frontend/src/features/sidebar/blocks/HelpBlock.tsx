import { Trans } from "@lingui/react/macro";
import {
	ChatCircle,
	EnvelopeSimple,
	Note,
	Pulse,
	Users,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { FeedbackPortalModal } from "@/components/common/FeedbackPortalModal";
import { COMMUNITY_SLACK_URL } from "@/config";
import { NavButton } from "../primitives/NavButton";
import { SectionLabel } from "../primitives/SectionLabel";

export const HelpBlock = () => {
	const { language } = useParams();
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	const docUrl =
		language === "nl-NL"
			? "https://docs.dembrane.com/nl-NL"
			: "https://docs.dembrane.com/en-US";

	return (
		<>
			<div className="flex flex-col gap-0.5">
				<SectionLabel>
					<Trans>Help</Trans>
				</SectionLabel>
				<NavButton
					label={<Trans>Contact support</Trans>}
					icon={EnvelopeSimple}
					external
					onClick={() => {
						window.location.href = "mailto:support@dembrane.com";
					}}
				/>
				<NavButton
					label={<Trans>Documentation</Trans>}
					icon={Note}
					external
					onClick={() => window.open(docUrl, "_blank", "noopener,noreferrer")}
				/>
				<NavButton
					label={<Trans>Slack community</Trans>}
					icon={Users}
					external
					onClick={() =>
						window.open(COMMUNITY_SLACK_URL, "_blank", "noopener,noreferrer")
					}
				/>
				<NavButton
					label={<Trans>System status</Trans>}
					icon={Pulse}
					onClick={() => undefined}
					badge={<Trans>Planned</Trans>}
					disabled
				/>
				<NavButton
					label={<Trans>Feedback</Trans>}
					icon={ChatCircle}
					onClick={() => setFeedbackOpen(true)}
				/>
			</div>
			<FeedbackPortalModal
				opened={feedbackOpen}
				onClose={() => setFeedbackOpen(false)}
				locale={language}
			/>
		</>
	);
};
