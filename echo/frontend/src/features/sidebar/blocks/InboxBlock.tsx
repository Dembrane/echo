import { Trans } from "@lingui/react/macro";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useSearchParams } from "react-router";
import { useUnreadAnnouncements } from "@/components/announcement/hooks";
import { useUnreadNotificationCount } from "@/hooks/useNotifications";
import { usePendingActionCount } from "../hooks/usePendingActions";
import {
	SIDEBAR_TAB_PARAM,
	useSidebarOverlayLink,
} from "../hooks/useSidebarOverlayLink";
import { useSidebarView } from "../hooks/useSidebarView";
import { NavItem } from "../primitives/NavItem";
import { InboxUpdatesRow } from "./InboxUpdatesRow";
import { selectUpdatesLabel } from "./updatesLabel";

export const InboxBlock = () => {
	const to = useSidebarOverlayLink("inbox");
	const { overlay } = useSidebarView();
	const [searchParams] = useSearchParams();
	const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
	const { data: unreadAnnouncements = 0 } = useUnreadAnnouncements();
	// Additive pending-action sources (high-risk training nudge, and future
	// waves). Compounded into the Inbox count, never overwritten.
	const pendingActions = usePendingActionCount();
	const total = unreadNotifications + unreadAnnouncements + pendingActions;

	// Same helper the sub-row uses. Without it, nothing holds the selection on
	// the Updates tab once everything is read.
	const hasSubRow = selectUpdatesLabel({ count: unreadAnnouncements }).visible;
	const onUpdatesTab = searchParams.get(SIDEBAR_TAB_PARAM) === "updates";

	// Flush, so the updates sub-row reads as part of Inbox rather than a peer.
	return (
		<div className="flex flex-col">
			<NavItem
				to={to}
				label={<Trans>Inbox</Trans>}
				icon={EnvelopeSimpleIcon}
				pushes
				active={overlay === "inbox" && !(onUpdatesTab && hasSubRow)}
				badge={total > 0 ? total : undefined}
				// A pending action (e.g. training nudge) gets the warm "pending" tone
				// (graphite text); otherwise the standard notification tone.
				badgeTone={pendingActions > 0 ? "pending" : "notification"}
			/>
			<InboxUpdatesRow />
		</div>
	);
};
