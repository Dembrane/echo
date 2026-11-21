import { useState } from "react";
import { useLocation } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { nextTaskText } from "../format";
import { useAccountsCatalog } from "../i18n";
import { captureSigning, SIGNING_EVENTS } from "../signing/signingEvents";
import { SignPromptBanner } from "./SignPromptBanner/SignPromptBanner";
import { markPromptSeen, promptFor, promptSeen } from "./tasksPromptState";
import { useTasksSummary } from "./tasksSummary";

/**
 * The banner at the top of the dashboard for someone with tasks waiting on them: it reads
 * the tasks summary and hands the block what to show. Closed, it stays away for the rest
 * of the browser session and comes back in the next one, until nothing waits. It never
 * shows on that organisation's overview, Tasks or account page, where it would only
 * repeat them. Loaded lazily by BaseLayout: it fetches the account tasks summary, which
 * the portal never needs.
 */
export default function SignPromptBannerConnected() {
	const { data } = useTasksSummary();
	const catalogReady = useAccountsCatalog();
	const navigate = useI18nNavigate();
	const { pathname } = useLocation();
	const [dismissed, setDismissed] = useState(promptSeen);

	const row = promptFor(data);
	if (dismissed || !row || !catalogReady || onOrgPage(pathname, row.org_id))
		return null;
	return (
		<SignPromptBanner
			orgName={row.name}
			tasksWaiting={row.tasks_waiting}
			nextTask={nextTaskText(row)}
			onOpen={() => navigate(`/o/${row.org_id}/overview`)}
			onDismiss={() => {
				markPromptSeen();
				setDismissed(true);
				captureSigning(SIGNING_EVENTS.promptDismissed, {
					id: row.next_task_document_id ?? null,
					kind: row.next_task_document_kind ?? null,
				});
			}}
		/>
	);
}

/** On the organisation's overview, Tasks or account page, where the banner would only repeat it. */
const onOrgPage = (pathname: string, orgId: string) =>
	new RegExp(`/o/${orgId}/(overview|tasks|account)/?$`).test(pathname);
