import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * Lets a shortcut elsewhere in the app land on one control of a long
 * settings page: when the URL hash matches, the control is scrolled into
 * view and focused once it mounts.
 */
export const useFocusOnHash = <T extends HTMLElement>(hash: string) => {
	const ref = useRef<T>(null);
	const location = useLocation();

	useEffect(() => {
		if (location.hash !== `#${hash}` || !ref.current) return;
		ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
		ref.current.focus({ preventScroll: true });
	}, [location.hash, hash]);

	return ref;
};
