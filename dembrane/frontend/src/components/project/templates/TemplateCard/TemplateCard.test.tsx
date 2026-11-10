// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { UsersThreeIcon } from "@phosphor-icons/react";
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

describe("TemplateCard", () => {
	it("shows the name, when to pick it and each fact as a list item", () => {
		render(
			<MantineProvider>
				<TemplateCard
					icon={UsersThreeIcon}
					name="A live event"
					when="Many tables at once."
					facts={["Asks each table for its name", "Adds 2 tags"]}
					testId="card"
				/>
			</MantineProvider>,
		);
		expect(screen.getByText("A live event")).toBeTruthy();
		expect(screen.getByText("Many tables at once.")).toBeTruthy();
		expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
			["Asks each table for its name", "Adds 2 tags"],
		);
		// The icon is decoration: the name says what the card is.
		expect(
			screen
				.getByTestId("card")
				.querySelector("svg")
				?.getAttribute("aria-hidden"),
		).toBe("true");
	});

	it("leaves the list out when there is nothing to list", () => {
		render(
			<MantineProvider>
				<TemplateCard icon={UsersThreeIcon} name="N" when="W" facts={[]} />
			</MantineProvider>,
		);
		expect(screen.queryByRole("list")).toBeNull();
	});
});
