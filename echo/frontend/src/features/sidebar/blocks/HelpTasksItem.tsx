import { Trans } from "@lingui/react/macro";
import { ListChecks } from "@phosphor-icons/react";
import { useEffect } from "react";
import {
	summarise,
	useTasksSummary,
} from "@/features/accounts/help/tasksSummary";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { NavButton } from "../primitives/NavButton";

/**
 * "Tasks" in the Help menu: what the caller's organisations still have to do for
 * dembrane, as done/total. Hidden when no org has a task. Loaded lazily by HelpBlock, so
 * the dashboard shell and the portal carry only the import.
 */
export default function HelpTasksItem({
	onPresence,
}: {
	/** Probe mode: report whether there is anything to show, render nothing. */
	onPresence?: (present: boolean) => void;
}) {
	const navigate = useI18nNavigate();
	const { data } = useTasksSummary();
	const { orgs, done, total } = summarise(data);
	useEffect(() => {
		onPresence?.(orgs.length > 0);
	}, [onPresence, orgs.length]);
	if (onPresence || orgs.length === 0) return null;
	const only = orgs.length === 1 ? orgs[0] : null;
	return (
		<span data-testid="help-tasks">
			<NavButton
				label={<Trans>Tasks</Trans>}
				icon={ListChecks}
				badge={`${done}/${total}`}
				onClick={() =>
					navigate(only ? `/o/${only.org_id}/account` : "/account")
				}
			/>
		</span>
	);
}
