// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
	ImproveTranscriptFrame,
	LOOP_SECONDS,
	sceneAt,
} from "./ImproveTranscriptAnimation";

const visible = (t: number) => {
	const { container } = render(<ImproveTranscriptFrame t={t} />);
	const group = container.querySelector("svg > g");
	return Number(group?.getAttribute("opacity"));
};

describe("ImproveTranscriptFrame", () => {
	test("renders every frame of the loop", () => {
		for (let t = 0; t <= LOOP_SECONDS; t += 0.25)
			expect(visible(t)).toBeGreaterThanOrEqual(0);
	});

	test("the loop ends empty, as it starts, so it does not jump", () => {
		expect(visible(LOOP_SECONDS - 0.01)).toBeLessThan(0.01);
		const { container } = render(<ImproveTranscriptFrame t={0} />);
		// What a viewer sees: a shape's own opacity times every group around it.
		const seen = (el: Element | null): number =>
			el && el.tagName !== "svg"
				? Number(el.getAttribute("opacity") ?? 1) * seen(el.parentElement)
				: 1;
		const shown = [...container.querySelectorAll("rect, path, circle")].filter(
			(r) => seen(r) > 0.01 && Number(r.getAttribute("height") ?? 1) > 0.5,
		);
		expect(shown).toHaveLength(0);
	});

	test("one line per scene, in order, each fully shown at some point", () => {
		const seen = new Map<number, number>();
		let last = 0;
		for (let t = 0; t < LOOP_SECONDS; t += 0.05) {
			const { scene, opacity } = sceneAt(t);
			expect(scene).toBeGreaterThanOrEqual(last);
			last = scene;
			seen.set(scene, Math.max(seen.get(scene) ?? 0, opacity));
		}
		expect([...seen.keys()]).toEqual([0, 1, 2, 3]);
		for (const peak of seen.values()) expect(peak).toBeGreaterThan(0.99);
	});
});
