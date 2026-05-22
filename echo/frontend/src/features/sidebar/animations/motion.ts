// All sidebar animation tuning lives here. Primitives import from this
// module so timings and easings can be tweaked in one place. To disable
// motion for reduced-motion users, the consumer hook returns 0 durations.

export const EASE_OUT_CUBIC: [number, number, number, number] = [
	0.32, 0.72, 0, 1,
];

export const TIMINGS = {
	activePill: { damping: 30, stiffness: 400, type: "spring" } as const,
	labelFade: 0.12,
	sectionExpand: 0.18,
	treeStagger: 0.03,
	viewSwap: 0.22,
	widthSpring: { damping: 36, stiffness: 380, type: "spring" } as const,
};

export const VIEW_SLIDE_PX = 24;

export const viewSwapVariants = {
	pop: {
		animate: { opacity: 1, x: 0 },
		exit: { opacity: 0, x: VIEW_SLIDE_PX },
		initial: { opacity: 0, x: -VIEW_SLIDE_PX },
	},
	push: {
		animate: { opacity: 1, x: 0 },
		exit: { opacity: 0, x: -VIEW_SLIDE_PX },
		initial: { opacity: 0, x: VIEW_SLIDE_PX },
	},
} as const;

export function usePrefersReducedMotion(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
