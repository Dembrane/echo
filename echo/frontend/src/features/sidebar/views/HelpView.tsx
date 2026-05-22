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
import { useSidebarView } from "../hooks/useSidebarView";
import { NavButton } from "../primitives/NavButton";
import { ViewHeader } from "../primitives/ViewHeader";

export const HelpView = () => {
	const { backTo } = useSidebarView();
	const { language } = useParams();
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	const docUrl =
		language === "nl-NL"
			? "https://docs.dembrane.com/nl-NL"
			: "https://docs.dembrane.com/en-US";

	return (
		<>
			<nav className="flex h-full flex-col gap-0.5 p-1.5">
				<ViewHeader to={backTo ?? "/w"} title={<Trans>Help</Trans>} />
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

				<div className="mt-auto" />
				<NavButton
					label={<Trans>Feedback</Trans>}
					icon={ChatCircle}
					onClick={() => setFeedbackOpen(true)}
				/>
			</nav>
			<FeedbackPortalModal
				opened={feedbackOpen}
				onClose={() => setFeedbackOpen(false)}
				locale={language}
			/>
		</>
	);
};
