import { Trans } from "@lingui/react/macro";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * A step's pill keeps its row with Back: when its full label ("Fill in your address")
 * does not fit beside Back, it says the short one instead ("Continue"), and the full one
 * again once there is room. Spread `fitting` on the Button so it may shrink.
 */
export function FitLabel({
	children,
	short = <Trans>Continue</Trans>,
}: {
	children: ReactNode;
	short?: ReactNode;
}) {
	const box = useRef<HTMLSpanElement>(null);
	const full = useRef<HTMLSpanElement>(null);
	const [fits, setFits] = useState(true);
	useLayoutEffect(() => {
		const b = box.current;
		const f = full.current;
		if (!b || !f) return;
		const check = () => setFits(f.offsetWidth <= b.clientWidth + 1);
		const observer = new ResizeObserver(check);
		observer.observe(b);
		check();
		return () => observer.disconnect();
	});
	return (
		<span
			ref={box}
			style={{
				display: "block",
				minWidth: 0,
				overflow: "hidden",
				position: "relative",
				textAlign: "center",
			}}
		>
			{/* Always laid out, so the button asks for the full label's width. */}
			<span
				ref={full}
				aria-hidden={!fits}
				style={{
					visibility: fits ? "visible" : "hidden",
					whiteSpace: "nowrap",
				}}
			>
				{children}
			</span>
			{!fits && (
				<span
					style={{
						left: 0,
						position: "absolute",
						right: 0,
						whiteSpace: "nowrap",
					}}
				>
					{short}
				</span>
			)}
		</span>
	);
}

/** On the pill: it may shrink beside Back instead of pushing the row wider. */
export const fitting = {
	styles: {
		inner: { minWidth: 0 },
		label: { minWidth: 0 },
		root: { flexShrink: 1, minWidth: 0 },
	},
} as const;
