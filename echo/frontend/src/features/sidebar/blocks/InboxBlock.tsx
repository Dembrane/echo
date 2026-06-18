import { Trans } from "@lingui/react/macro";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useUnreadAnnouncements } from "@/components/announcement/hooks";
import { useUnreadNotificationCount } from "@/hooks/useNotifications";
import { usePendingActionCount } from "../hooks/usePendingActions";
import { useSidebarOverlayLink } from "../hooks/useSidebarOverlayLink";
import { useSidebarView } from "../hooks/useSidebarView";
import { NavItem } from "../primitives/NavItem";

export const InboxBlock = () => {
	const to = useSidebarOverlayLink("inbox");
	const { overlay } = useSidebarView();
	const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
	const { data: unreadAnnouncements = 0 } = useUnreadAnnouncements();
	// Additive pending-action sources (high-risk training nudge, and future
	// waves). Compounded into the Inbox count, never overwritten.
	const pendingActions = usePendingActionCount();
	const total = unreadNotifications + unreadAnnouncements + pendingActions;

	return (
		<NavItem
			to={to}
			label={<Trans>Inbox</Trans>}
			icon={EnvelopeSimpleIcon}
			pushes
			active={overlay === "inbox"}
			badge={total > 0 ? total : undefined}
			// A pending action (e.g. training nudge) gets the warm "pending" tone
			// (graphite text); otherwise the standard notification tone.
			badgeTone={pendingActions > 0 ? "pending" : "notification"}
		/>
	);
};
