// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_KEYS } from "../projectTemplates";
import { DRAWINGS } from "./drawings";
import { TemplateIllustration } from "./TemplateIllustration";

afterEach(cleanup);

describe("TemplateIllustration", () => {
	it("has a drawing for every card, each one different", () => {
		expect(Object.keys(DRAWINGS).sort()).toEqual([...CARD_KEYS].sort());
		const marks = CARD_KEYS.map((key) =>
			renderToStaticMarkup(<TemplateIllustration template={key} />),
		);
		expect(
			new Set(marks.map((m) => m.replace(/data-testid="[^"]*"/, ""))).size,
		).toBe(CARD_KEYS.length);
	});

	it("is decoration: hidden, no text, no gradients, one accent from the theme", () => {
		for (const key of CARD_KEYS) {
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
