// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	Providers,
	setUpDom,
} from "@/components/project/setup-suggestions/testing";
import { TemplateCard } from "./TemplateCard";

afterEach(cleanup);
beforeAll(setUpDom);

const renderCard = (props: Partial<Parameters<typeof TemplateCard>[0]> = {}) =>
	render(
		<Providers>
			<TemplateCard
				template="resident_evening"
				name="Table conversations"
				greatFor="Great for resident evenings."
				tags={["Understand", "Many groups at once"]}
				testId="card"
				{...props}
			/>
		</Providers>,
	);

describe("TemplateCard", () => {
	it("shows the room, then name, Great for and the tags, in that order", () => {
		renderCard();
		const card = screen.getByTestId("card");
		expect(card.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		const text = card.textContent ?? "";
		const order = [
			"Table conversations",
			"Great for resident evenings.",
			"Understand",
			"Many groups at once",
		].map((s) => text.indexOf(s));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("hides the drawing from screen readers", () => {
		renderCard();
		const svg = screen.getByTestId("template-illustration-resident_evening");
		expect(svg.getAttribute("aria-hidden")).toBe("true");
	});

	it("shows each tag on its own, and none when there are none", () => {
		renderCard({ tags: ["World Café", "Explore"] });
		expect(
			screen
				.getByTestId("template-card-tags")
				.querySelectorAll(".mantine-Badge-root"),
		).toHaveLength(2);
		cleanup();
		renderCard({ tags: [] });
		expect(screen.queryByTestId("template-card-tags")).toBeNull();
	});
});
