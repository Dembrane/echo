/**
 * A small burst from the thumb the host just pressed.
 *
 * Twenty-four pieces, under a second, in the brand's bright accents, drawn on
 * the document so no row grows to hold them. A host who asked for less motion
 * gets none: the thanks is in the words either way.
 */
const PIECES = 24;
const MILLISECONDS = 900;
const ACCENTS = ["#4169e1", "#f5a623", "#39b54a", "#e1416b", "#7c9bff"];

const quiet = (): boolean => {
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		// A browser without matchMedia, or a test one: the burst is decoration
		// and its absence costs nothing.
		return true;
	}
};

export function burstFrom(anchor: Element | null): void {
	if (!anchor || quiet() || typeof anchor.getBoundingClientRect !== "function")
		return;
	const box = anchor.getBoundingClientRect();
	const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	const stage = document.createElement("div");
	stage.setAttribute("aria-hidden", "true");
	stage.style.cssText =
		"position:fixed;inset:0;pointer-events:none;z-index:400;overflow:hidden";

	for (let at = 0; at < PIECES; at += 1) {
		const piece = document.createElement("span");
		// Upwards and outwards, wider than it is tall, so the burst reads as a
		// pop rather than a fountain.
		const angle = (Math.PI * (at + Math.random())) / PIECES + Math.PI;
		const reach = 40 + Math.random() * 70;
		piece.style.cssText = `position:absolute;left:${from.x}px;top:${from.y}px;width:6px;height:6px;border-radius:1px;background:${ACCENTS[at % ACCENTS.length]}`;
		piece.animate?.(
			[
				{ opacity: 1, transform: "translate(-50%,-50%) scale(1) rotate(0deg)" },
				{
					offset: 1,
					opacity: 0,
					transform: `translate(calc(-50% + ${Math.cos(angle) * reach}px), calc(-50% + ${Math.sin(angle) * reach + 30}px)) scale(0.6) rotate(${Math.round(Math.random() * 360)}deg)`,
				},
			],
			{
				duration: MILLISECONDS * (0.7 + Math.random() * 0.3),
				easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
			},
		);
		stage.append(piece);
	}

	document.body.append(stage);
	window.setTimeout(() => stage.remove(), MILLISECONDS + 100);
}
