import { Plural } from "@lingui/react/macro";
import { useSearchParams } from "react-router";
import {
	useTopUrgentUnreadAnnouncement,
	useUnreadAnnouncements,
} from "@/components/announcement/hooks";
import { getTranslatedContent } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useLanguage } from "@/hooks/useLanguage";
import {
	SIDEBAR_TAB_PARAM,
	useSidebarOverlayLink,
} from "../hooks/useSidebarOverlayLink";
import { useSidebarView } from "../hooks/useSidebarView";
import { NavItem } from "../primitives/NavItem";
import { selectUpdatesLabel } from "./updatesLabel";

/** Sub-row of Inbox, only while an announcement is unread. Links to Updates. */
export const InboxUpdatesRow = () => {
	const to = useSidebarOverlayLink("inbox", { tab: "updates" });
	const { language } = useLanguage();
	const { data: count = 0 } = useUnreadAnnouncements();
	const { data: urgent } = useTopUrgentUnreadAnnouncement();
	const { overlay } = useSidebarView();
	const [searchParams] = useSearchParams();
	const active =
		overlay === "inbox" && searchParams.get(SIDEBAR_TAB_PARAM) === "updates";

	const urgentTitle = urgent
		? getTranslatedContent(urgent, language).title
		: null;

	const state = selectUpdatesLabel({ count, urgentTitle });

	if (!state.visible) return null;

	// No badge: the count lives once, on the Inbox row above.
	return (
		<NavItem
			to={to}
			label={
				state.urgent ? (
					state.title
				) : (
					<Plural
						value={state.count}
						one="Message from dembrane"
						other="Messages from dembrane"
					/>
				)
			}
			active={active}
			inset
		/>
	);
};
