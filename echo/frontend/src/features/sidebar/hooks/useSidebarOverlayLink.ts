import { useMemo } from "react";
import { useLocation } from "react-router";

/** Which Inbox tab a link opens. Absent means the default, "For you". */
export type InboxTab = "updates";

/** Namespaced: overlay links always resolve it, so a plain `tab` would clash. */
export const SIDEBAR_TAB_PARAM = "sidebar-tab";

export function useSidebarOverlayLink(
	view: "inbox" | "help",
	options?: { tab?: InboxTab },
) {
	const { pathname, search } = useLocation();
	const tab = options?.tab;

	return useMemo(() => {
		const params = new URLSearchParams(search);
		params.set("sidebar", view);
		// Resolve, never inherit: otherwise plain Inbox lands on Updates.
		if (tab) {
			params.set(SIDEBAR_TAB_PARAM, tab);
		} else {
			params.delete(SIDEBAR_TAB_PARAM);
		}
		const next = params.toString();
		return `${pathname}${next ? `?${next}` : ""}`;
	}, [pathname, search, view, tab]);
}
