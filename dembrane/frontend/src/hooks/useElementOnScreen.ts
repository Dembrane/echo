import { useEffect, useRef, useState } from "react";

export const useElementOnScreen = (
	options: IntersectionObserverInit,
): [React.RefObject<HTMLDivElement | null>, boolean] => {
	const containerRef = useRef<HTMLDivElement>(null);
	// On screen until the observer says otherwise: its first report lands a
	// frame after mount, and starting off screen flashed the portal's
	// scroll-to-bottom arrow on every page load.
	const [isVisible, setIsVisible] = useState(true);

	const callbackFunction = (entries: IntersectionObserverEntry[]) => {
		const [entry] = entries;
		setIsVisible(entry.isIntersecting);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
	useEffect(() => {
		const observer = new IntersectionObserver(callbackFunction, options);
		if (containerRef.current) observer.observe(containerRef.current);

		return () => {
			if (containerRef.current) observer.unobserve(containerRef.current);
		};
	}, [containerRef, options]);

	return [containerRef, isVisible];
};
