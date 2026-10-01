import { useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSidebarState } from "../hooks/useSidebarState";

// Null leaf: closes the mobile drawer on entering mobile and after every
// navigation, keeping route-change re-renders out of the sidebar body.
export const MobileSidebarAutoClose = () => {
	const isMobile = useIsMobile();
	const { pathname } = useLocation();
	const { setCollapsed } = useSidebarState();

	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is intentional for re-closing on navigation
	useLayoutEffect(() => {
		if (isMobile) setCollapsed(true);
	}, [isMobile, pathname, setCollapsed]);

	return null;
};
