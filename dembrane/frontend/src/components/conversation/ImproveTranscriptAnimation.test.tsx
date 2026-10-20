// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
	ImproveTranscriptFrame,
	LOOP_SECONDS,
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
		const shown = [...container.querySelectorAll("rect")].filter(
			(r) =>
				Number(r.getAttribute("height")) > 0.5 &&
				Number(r.getAttribute("opacity") ?? 1) > 0.01,
		);
		expect(shown).toHaveLength(0);
	});
});
