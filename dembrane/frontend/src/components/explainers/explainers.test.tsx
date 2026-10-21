// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { anonymise } from "./anonymise";
import { chat } from "./chat";
import { explore } from "./explore";
import { type Loop, sceneAt } from "./kit";
import { map } from "./map";
import { popcorn } from "./popcorn";
import { report } from "./report";
import { verify } from "./verify";

i18n.load("en", {});
i18n.activate("en");

const loops: Record<string, Loop> = {
	anonymise,
	chat,
	explore,
	map,
	popcorn,
	report,
	verify,
};

// What a viewer sees: a shape's own opacity times every group around it.
const seen = (el: Element | null): number =>
	el && el.tagName !== "svg"
		? Number(el.getAttribute("opacity") ?? 1) * seen(el.parentElement)
		: 1;

const draw = (loop: Loop, t: number) =>
	render(<svg aria-hidden="true">{loop.draw(t)}</svg>).container;

describe.each(Object.entries(loops))("%s loop", (_, loop) => {
	test("renders every frame", () => {
		for (let t = 0; t < loop.seconds; t += 0.25)
			expect(() => draw(loop, t)).not.toThrow();
	});

	test("starts empty, so the loop does not jump", () => {
		const shown = [
			...draw(loop, 0).querySelectorAll("rect, path, circle, line"),
		].filter((el) => seen(el) > 0.01);
		expect(shown).toHaveLength(0);
	});

	test("one line per scene, six words or fewer, each fully shown", () => {
		const lines = loop.lines();
		expect(lines).toHaveLength(loop.scenes.length);
		for (const line of lines)
			expect(line.split(/\s+/).length).toBeLessThanOrEqual(6);
		const peak = new Map<number, number>();
		for (let t = 0; t < loop.seconds; t += 0.05) {
			const { scene, opacity } = sceneAt(loop, t);
			peak.set(scene, Math.max(peak.get(scene) ?? 0, opacity));
		}
		for (const p of peak.values()) expect(p).toBeGreaterThan(0.99);
	});
});
