import { Trans } from "@lingui/react/macro";
import {
	Bug,
	ChatCircle,
	EnvelopeSimple,
	Note,
	Pulse,
	Users,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { COMMUNITY_SLACK_URL, getDocumentationUrl } from "@/config";
import { useHelpModals } from "../hooks/useHelpModals";
import { useSidebarView } from "../hooks/useSidebarView";
import { NavButton } from "../primitives/NavButton";
import { ViewHeader } from "../primitives/ViewHeader";

export const HelpView = () => {
	const { backTo } = useSidebarView();
	const { language } = useParams();
	const { openFeedback, openReportIssue } = useHelpModals();
	const docUrl = getDocumentationUrl(language);

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<ViewHeader to={backTo ?? "/o"} title={<Trans>Help</Trans>} />
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
		</nav>
	);
};
