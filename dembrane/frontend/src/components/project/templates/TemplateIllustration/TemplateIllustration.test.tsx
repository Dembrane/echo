// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_KEYS, type ChoiceKey, QUICK_START } from "../projectTemplates";
import { DRAWINGS } from "./drawings";
import { TemplateIllustration } from "./TemplateIllustration";

afterEach(cleanup);

const KEYS: ChoiceKey[] = [QUICK_START, ...CARD_KEYS];

describe("TemplateIllustration", () => {
	it("has a drawing for every card and Quick start, each one different", () => {
		expect(Object.keys(DRAWINGS).sort()).toEqual([...KEYS].sort());
		const marks = KEYS.map((key) =>
			renderToStaticMarkup(<TemplateIllustration template={key} />),
		);
		expect(
			new Set(marks.map((m) => m.replace(/data-testid="[^"]*"/, ""))).size,
		).toBe(KEYS.length);
	});

	it("draws Quick start as one solid table with its phone and no one at it", () => {
		const { container } = render(<TemplateIllustration template="blank" />);
		const svg = container.querySelector("svg") as SVGElement;
		// Solid: a dashed box under the drop zone would read as a second place to drop files.
		expect(svg.querySelector("[stroke-dasharray]")).toBeNull();
		expect(
			svg.querySelectorAll('rect[fill="none"], rect:not([fill])'),
		).toHaveLength(1);
		expect(svg.querySelectorAll("circle")).toHaveLength(0);
		expect(svg.querySelectorAll('rect[fill="var(--app-action)"]')).toHaveLength(
			1,
		);
	});

	it("is decoration: hidden, no text, no gradients, one accent from the theme", () => {
		for (const key of KEYS) {
			const { container } = render(<TemplateIllustration template={key} />);
			const svg = container.querySelector("svg") as SVGElement;
			expect(svg.getAttribute("aria-hidden")).toBe("true");
			expect(svg.getAttribute("viewBox")).toBe("0 0 160 80");
			expect(
				svg.querySelector("text, linearGradient, radialGradient, image"),
			).toBeNull();
			const fills = new Set(
				[...svg.querySelectorAll("[fill]")]
					.map((el) => el.getAttribute("fill"))
					.filter((f) => f !== "none" && f !== "currentColor"),
			);
			expect([...fills].every((f) => f === "var(--app-action)")).toBe(true);
			cleanup();
		}
	});
});
