// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEMPLATE_SUMMARIES } from "../projectTemplates.fixture";
import { TemplatePicker } from "./TemplatePicker";

afterEach(cleanup);
beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
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

const renderPicker = (
	props: Partial<ComponentProps<typeof TemplatePicker>> = {},
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<TemplatePicker
					templates={TEMPLATE_SUMMARIES}
					value={null}
					onChange={() => {}}
					{...props}
				/>
			</MantineProvider>
		</I18nProvider>,
	);

describe("TemplatePicker", () => {
	it("asks what the host is going to do, one radio per template card", () => {
		renderPicker();
		const group = screen.getByRole("radiogroup", {
			name: "What are you going to do?",
		});
		expect(group).toBeTruthy();
		expect(
			screen.getAllByRole("radio").map((r) => r.getAttribute("data-testid")),
		).toEqual([
			"template-card-conversation",
			"template-card-series",
			"template-card-event",
			"template-card-upload",
		]);
		// Blank is the quiet button, not a card.
		expect(screen.queryByTestId("template-card-blank")).toBeNull();
	});

	it("carries the walkthrough anchor", () => {
		renderPicker();
		expect(
			screen.getByTestId("template-picker").getAttribute("data-tour"),
		).toBe("template-picker");
	});

	it("hands the chosen key out and shows it checked", () => {
		const onChange = vi.fn();
		const view = renderPicker({ onChange });
		fireEvent.click(screen.getByTestId("template-card-event"));
		expect(onChange).toHaveBeenCalledWith("event");
		view.unmount();
		renderPicker({ value: "event" });
		expect(
			screen.getByTestId("template-card-event").getAttribute("aria-checked"),
		).toBe("true");
	});

	it("shows what each card sets up from the summary", () => {
		renderPicker();
		const event = screen.getByTestId("template-card-event");
		expect(event.textContent).toContain("A live event");
		expect(event.textContent).toContain("Asks each table for its name");
	});

	it("offers Start blank only when it can be used", () => {
		const onStartBlank = vi.fn();
		const view = renderPicker({ onStartBlank });
		fireEvent.click(screen.getByTestId("template-picker-start-blank"));
		expect(onStartBlank).toHaveBeenCalled();
		view.unmount();
		renderPicker();
		expect(screen.queryByTestId("template-picker-start-blank")).toBeNull();
	});

	it("waits while loading and keeps blank open when the list fails", () => {
		const view = renderPicker({ templates: undefined });
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
		view.unmount();
		renderPicker({
			failed: true,
			onStartBlank: () => {},
			templates: undefined,
		});
		expect(screen.getByTestId("template-picker-failed")).toBeTruthy();
		expect(screen.getByTestId("template-picker-start-blank")).toBeTruthy();
	});
});
