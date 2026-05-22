import { motion } from "motion/react";
import { type ReactNode, useRef } from "react";
import { useSidebarView, viewDepth } from "../hooks/useSidebarView";
import {
	EASE_OUT_CUBIC,
	TIMINGS,
	usePrefersReducedMotion,
	VIEW_SLIDE_PX,
} from "./motion";

interface ViewTransitionProps {
	children: ReactNode;
}

// AnimatePresence-backed wrapper. Direction (push/pop) is derived from
// the change in view depth — drilling in slides left, going back slides
// right. URL is the source of truth; this just decorates the swap.
export const ViewTransition = ({ children }: ViewTransitionProps) => {
	const { view } = useSidebarView();
	const prevDepthRef = useRef<number>(viewDepth(view));
	const direction = useRef<"push" | "pop">("push");
	const reduced = usePrefersReducedMotion();

	const currentDepth = viewDepth(view);
	if (currentDepth > prevDepthRef.current) direction.current = "push";
	else if (currentDepth < prevDepthRef.current) direction.current = "pop";
	prevDepthRef.current = currentDepth;

	const slide = direction.current === "push" ? VIEW_SLIDE_PX : -VIEW_SLIDE_PX;

	return (
		<div className="relative flex-1 overflow-hidden">
			<motion.div
				key={view}
				initial={reduced ? false : { opacity: 0, x: slide }}
				animate={{ opacity: 1, x: 0 }}
				transition={{ duration: TIMINGS.viewSwap, ease: EASE_OUT_CUBIC }}
				className="flex h-full flex-col"
			>
				{children}
			</motion.div>
		</div>
	);
};
