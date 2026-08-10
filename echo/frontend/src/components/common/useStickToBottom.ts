import { useCallback, useEffect, useRef, useState } from "react";
import {
	evaluateScrollPosition,
	resolveScrollContainer,
} from "./scrollPosition";

/** One measurement drives both the scroll-to-bottom button and autoscroll, so
 * the two can never disagree about where the reader is. Measured once on mount
 * (no flash) and then on scroll, resize, and content growth. */
export const useStickToBottom = (
	anchorRef: React.RefObject<HTMLElement | null>,
) => {
	const [state, setState] = useState({
		isAtBottom: true,
		showScrollButton: false,
	});
	const isAtBottomRef = useRef(true);
	const containerRef = useRef<HTMLElement | null>(null);

	const measure = useCallback(() => {
		const container =
			containerRef.current ?? resolveScrollContainer(anchorRef.current);
		if (!container) return;
		containerRef.current = container;
		const next = evaluateScrollPosition({
			clientHeight: container.clientHeight,
			scrollHeight: container.scrollHeight,
			scrollTop: container.scrollTop,
		});
		isAtBottomRef.current = next.isAtBottom;
		setState((prev) =>
			prev.isAtBottom === next.isAtBottom &&
			prev.showScrollButton === next.showScrollButton
				? prev
				: {
						isAtBottom: next.isAtBottom,
						showScrollButton: next.showScrollButton,
					},
		);
	}, [anchorRef]);

	useEffect(() => {
		let disposed = false;
		let detachListeners: (() => void) | null = null;
		let waitObserver: MutationObserver | null = null;

		const setupListeners = (anchor: HTMLElement) => {
			const container = resolveScrollContainer(anchor);
			containerRef.current = container;
			measure();
			if (!container) return;
			const scrollTarget: EventTarget =
				container === document.documentElement ||
				container === document.scrollingElement
					? window
					: container;
			scrollTarget.addEventListener("scroll", measure, { passive: true });
			window.addEventListener("resize", measure);
			const observer = new ResizeObserver(measure);
			observer.observe(container);
			// The container's own box does not change when its content grows, so
			// observing it alone would miss streaming messages entirely. The first
			// child is the content wrapper that actually gets taller.
			if (container.firstElementChild) {
				observer.observe(container.firstElementChild);
			}
			if (anchor !== container) {
				observer.observe(anchor);
			}
			detachListeners = () => {
				scrollTarget.removeEventListener("scroll", measure);
				window.removeEventListener("resize", measure);
				observer.disconnect();
			};
		};

		const attach = () => {
			if (disposed) return;
			const anchor = anchorRef.current;
			if (anchor) {
				setupListeners(anchor);
				return;
			}
			// Anchor isn't mounted yet (e.g. still on a loading/picker screen).
			// Watch for it instead of polling; disconnects once it appears.
			waitObserver = new MutationObserver(() => {
				if (!anchorRef.current) return;
				waitObserver?.disconnect();
				waitObserver = null;
				attach();
			});
			const waitRoot =
				document.querySelector<HTMLElement>("[data-app-scroll-root]") ??
				document.body;
			waitObserver.observe(waitRoot, { childList: true, subtree: true });
		};

		attach();

		return () => {
			disposed = true;
			waitObserver?.disconnect();
			detachListeners?.();
		};
	}, [anchorRef, measure]);

	const scrollToBottom = useCallback(
		(behavior: ScrollBehavior = "smooth") => {
			window.requestAnimationFrame(() => {
				const container =
					containerRef.current ?? resolveScrollContainer(anchorRef.current);
				if (!container) return;
				container.scrollTo({ behavior, top: container.scrollHeight });
			});
		},
		[anchorRef],
	);

	return {
		isAtBottom: state.isAtBottom,
		isAtBottomRef,
		measure,
		scrollToBottom,
		showScrollButton: state.showScrollButton,
	};
};
