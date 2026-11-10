// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { HouseLineIcon } from "@phosphor-icons/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TemplateCard } from "./TemplateCard";

afterEach(cleanup);
beforeAll(() => {
	window.matchMedia ||= ((query: string) =>
		({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
});

const renderCard = (props: Partial<Parameters<typeof TemplateCard>[0]> = {}) =>
	render(
		<MantineProvider>
			<TemplateCard
				icon={HouseLineIcon}
				name="Resident evening"
				greatFor="Great for resident evenings."
				facts={["Each table checks its own summary", "Rounds as tags"]}
				labels={["Understand", "Many groups at once"]}
				testId="card"
				{...props}
			/>
		</MantineProvider>,
	);

describe("TemplateCard", () => {
	it("reads name, Great for, facts, then the quiet labels", () => {
		renderCard();
		const text = screen.getByTestId("card").textContent ?? "";
		const order = [
			"Resident evening",
			"Great for resident evenings.",
			"Each table checks its own summary",
			"Understand · Many groups at once",
		].map((s) => text.indexOf(s));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("puts a named format first among the labels", () => {
		renderCard({ method: "World Café" });
		expect(screen.getByTestId("template-card-labels").textContent).toBe(
			"World Café · Understand · Many groups at once",
		);
	});

	it("leaves out the fact list and labels when there are none", () => {
		renderCard({ facts: [], labels: [] });
		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByTestId("template-card-labels")).toBeNull();
	});
});
