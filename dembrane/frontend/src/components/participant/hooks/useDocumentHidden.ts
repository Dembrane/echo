import { useEffect, useState } from "react";

/**
 * Whether the tab is hidden: switched away from, or the phone locked. On iOS
 * that suspends the mic, so recording effectively pauses.
 */
export const useDocumentHidden = () => {
	const [hidden, setHidden] = useState(
		typeof document !== "undefined" ? document.hidden : false,
	);

	useEffect(() => {
		const onVisibility = () => setHidden(document.hidden);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onVisibility);
		};
	}, []);

	return hidden;
};
