import { useMemo } from "react";
import { useLocation } from "react-router";

export function useSidebarOverlayLink(view: "inbox" | "help") {
	const { pathname, search } = useLocation();

	return useMemo(() => {
		const params = new URLSearchParams(search);
		params.set("sidebar", view);
		const next = params.toString();
		return `${pathname}${next ? `?${next}` : ""}`;
	}, [pathname, search, view]);
}
