import type { Locator, Page } from "@playwright/test";

// Headless Chrome draws no pointer, so the videos inject one: a dot that glides to what
// is about to be clicked and pulses on the click. Every move is eased and slow enough to
// follow; the viewer should always see where the next thing happens.

const CURSOR_SCRIPT = `
(() => {
	if (window.__videoCursor) return;
	const install = () => {
		if (!document.body) return requestAnimationFrame(install);
		const style = document.createElement("style");
		style.textContent = \`
			#video-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px;
				margin: -11px 0 0 -11px; border-radius: 50%; pointer-events: none;
				background: rgba(65, 105, 225, 0.35); border: 2px solid #4169e1;
				transition: transform 700ms cubic-bezier(0.45, 0, 0.2, 1), opacity 200ms; opacity: 0; }
			#video-cursor.pulse::after { content: ""; position: absolute; inset: -12px; border-radius: 50%;
				border: 2px solid #4169e1; animation: video-pulse 450ms ease-out forwards; }
			@keyframes video-pulse { from { transform: scale(0.4); opacity: 1 } to { transform: scale(1.3); opacity: 0 } }
			html { scroll-behavior: smooth; }
		\`;
		document.head.appendChild(style);
		const dot = document.createElement("div");
		dot.id = "video-cursor";
		document.body.appendChild(dot);
		window.__videoCursor = {
			move(x, y, ms) {
				dot.style.transitionDuration = ms + "ms, 200ms";
				dot.style.opacity = "1";
				dot.style.transform = "translate(" + x + "px, " + y + "px)";
			},
			pulse() { dot.classList.remove("pulse"); void dot.offsetWidth; dot.classList.add("pulse"); },
			hide() { dot.style.opacity = "0"; },
		};
	};
	install();
})();
`;

export async function installCursor(page: Page) {
	await page.addInitScript(CURSOR_SCRIPT);
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

export async function moveTo(page: Page, target: Locator, ms = 700) {
	await target.scrollIntoViewIfNeeded();
	const box = await target.boundingBox();
	if (!box) throw new Error(`cannot point at ${target}: not visible`);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.evaluate(CURSOR_SCRIPT);
	await page.evaluate(([x, y, ms]) => window.__videoCursor?.move(x, y, ms), [
		x,
		y,
		ms,
	] as const);
	await page.mouse.move(x, y, { steps: 8 });
	await pause(page, ms + 100);
}

export async function click(page: Page, target: Locator) {
	await moveTo(page, target);
	await page.evaluate(() => window.__videoCursor?.pulse());
	await target.click();
	await pause(page, 400);
}

/** Types at a readable pace, the way a person would. */
export async function type(
	page: Page,
	target: Locator,
	text: string,
	perChar = 45,
) {
	await click(page, target);
	await page.keyboard.type(text, { delay: perChar });
	await pause(page, 300);
}

export async function hideCursor(page: Page) {
	await page.evaluate(() => window.__videoCursor?.hide());
}

/** Scrolls an element into the middle of the view, smoothly. */
export async function reveal(page: Page, target: Locator, ms = 900) {
	await target.evaluate((el) =>
		el.scrollIntoView({ behavior: "smooth", block: "center" }),
	);
	await pause(page, ms);
}

declare global {
	interface Window {
		__videoCursor?: {
			move(x: number, y: number, ms: number): void;
			pulse(): void;
			hide(): void;
		};
	}
}
