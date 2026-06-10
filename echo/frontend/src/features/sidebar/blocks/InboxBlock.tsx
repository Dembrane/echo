import { Trans } from "@lingui/react/macro";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useUnreadAnnouncements } from "@/components/announcement/hooks";
import { useUnreadNotificationCount } from "@/hooks/useNotifications";
import { useSidebarOverlayLink } from "../hooks/useSidebarOverlayLink";
import { useSidebarView } from "../hooks/useSidebarView";
import { NavItem } from "../primitives/NavItem";

export const InboxBlock = () => {
	const to = useSidebarOverlayLink("inbox");
	const { overlay } = useSidebarView();
	const { data: unreadNotifications = 0 } = useUnreadNotificationCount();
	const { data: unreadAnnouncements = 0 } = useUnreadAnnouncements();
	const total = unreadNotifications + unreadAnnouncements;

	return (
		<NavItem
			to={to}
			label={<Trans>Inbox</Trans>}
			icon={EnvelopeSimpleIcon}
			pushes
			active={overlay === "inbox"}
			badge={total > 0 ? total : undefined}
			badgeTone="notification"
		/>
	);
};
