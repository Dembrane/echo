// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SUGGESTIONS } from "../setupSuggestions.fixture";
import { Providers, setUpDom } from "../testing";
import { SuggestedTerms } from "./SuggestedTerms";

afterEach(cleanup);
beforeAll(setUpDom);

const renderTerms = (
	props: Partial<ComponentProps<typeof SuggestedTerms>> = {},
) => {
	const handlers = {
		onAcceptAll: vi.fn(),
		onRemove: vi.fn(),
		onToggle: vi.fn(),
	};
	render(
		<Providers>
			<SuggestedTerms
				terms={SUGGESTIONS.key_terms}
				isAccepted={() => false}
				total={0}
				{...handlers}
				{...props}
			/>
		</Providers>,
	);
	return handlers;
};

describe("SuggestedTerms", () => {
	it("each chip is a toggle button named by its term, its reason read with it", () => {
		renderTerms({ isAccepted: (t) => t === "Strijp-S" });
		const chip = screen.getByRole("button", { name: "Marieke de Wolf" });
		expect(chip.getAttribute("aria-pressed")).toBe("false");
		const reason = document.getElementById(
			chip.getAttribute("aria-describedby") ?? "",
		);
		expect(reason?.textContent).toBe("De wethouder die de avond opent.");
		expect(
			screen
				.getByRole("button", { name: "Strijp-S" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("accepts, removes and accepts all through its callbacks", () => {
		const h = renderTerms();
		fireEvent.click(screen.getByRole("button", { name: "Woonbedrijf" }));
		expect(h.onToggle).toHaveBeenCalledWith("Woonbedrijf");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove Ennatuurlijk from the suggestions",
			}),
		);
		expect(h.onRemove).toHaveBeenCalledWith("Ennatuurlijk");
		fireEvent.click(screen.getByTestId("setup-suggestions-accept-all"));
		expect(h.onAcceptAll).toHaveBeenCalled();
	});

	it("Accept all is off once every term is accepted", () => {
		renderTerms({ isAccepted: () => true, total: 5 });
		expect(
			screen
				.getByTestId("setup-suggestions-accept-all")
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("says nothing about the cap until it is near", () => {
		renderTerms({ total: 23 });
		expect(screen.queryByTestId("setup-suggestions-cap")).toBeNull();
	});

	it("shows x of 30 near the cap", () => {
		renderTerms({ total: 26 });
		expect(screen.getByTestId("setup-suggestions-cap").textContent).toBe(
			"26 of 30 key terms",
		);
	});

	it("at the cap, new terms cannot be accepted but accepted ones can be undone", () => {
		renderTerms({ isAccepted: (t) => t === "Strijp-S", total: 30 });
		expect(screen.getByTestId("setup-suggestions-cap").textContent).toContain(
			"That is the most a project holds",
		);
		expect(
			screen
				.getByRole("button", { name: "Woonbedrijf" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen.getByRole("button", { name: "Strijp-S" }).hasAttribute("disabled"),
		).toBe(false);
		expect(
			screen
				.getByTestId("setup-suggestions-accept-all")
				.hasAttribute("disabled"),
		).toBe(true);
	});
});
