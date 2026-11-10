// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SUGGESTIONS } from "../setupSuggestions.fixture";
import { Providers, setUpDom } from "../testing";
import { SessionBrief } from "./SessionBrief";

afterEach(cleanup);
beforeAll(setUpDom);

type Props = ComponentProps<typeof SessionBrief>;
const base = (over: Partial<Props> = {}): Props => ({
	canSuggest: true,
	checkedSettings: {},
	isAccepted: () => false,
	notes: [],
	onAcceptAll: vi.fn(),
	onRemoveTerm: vi.fn(),
	onSuggest: vi.fn(),
	onTextChange: vi.fn(),
	onToggleSetting: vi.fn(),
	onToggleTerm: vi.fn(),
	onUrlChange: vi.fn(),
	settings: [],
	status: "idle",
	surface: "wizard",
	terms: [],
	totalTerms: 0,
	...over,
});
const renderBrief = (over: Partial<Props> = {}) => {
	const props = base(over);
	render(
		<Providers>
			<SessionBrief {...props} />
		</Providers>,
	);
	return props;
};

describe("SessionBrief", () => {
	it("idle: a named group with one text box, a link field and the action, and a walkthrough anchor", () => {
		const props = renderBrief();
		const group = screen.getByRole("group", {
			name: "Tell dembrane about your session",
		});
		expect(group.getAttribute("data-tour")).toBe("setup-suggestions");
		fireEvent.change(screen.getByLabelText("About your session"), {
			target: { value: "Bewonersavond" },
		});
		expect(props.onTextChange).toHaveBeenCalledWith("Bewonersavond");
		fireEvent.change(screen.getByLabelText(/Link to a page about it/), {
			target: { value: "https://example.org" },
		});
		expect(props.onUrlChange).toHaveBeenCalledWith("https://example.org");
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		expect(props.onSuggest).toHaveBeenCalled();
		expect(screen.queryByTestId("setup-suggestions-results")).toBeNull();
	});

	it("the action waits for something to read", () => {
		renderBrief({ canSuggest: false });
		expect(
			screen.getByTestId("setup-suggestions-submit").hasAttribute("disabled"),
		).toBe(true);
	});

	it("loading: the action spins and the live region says so politely", () => {
		renderBrief({ status: "loading" });
		const live = screen.getByTestId("setup-suggestions-status");
		expect(live.getAttribute("aria-live")).toBe("polite");
		expect(live.textContent).toContain("Reading what you wrote");
		expect(
			screen
				.getByTestId("setup-suggestions-submit")
				.getAttribute("data-loading"),
		).toBe("true");
	});

	it("results: chips and settings in place, announced as counts", () => {
		renderBrief({
			settings: SUGGESTIONS.settings,
			status: "results",
			terms: SUGGESTIONS.key_terms,
		});
		expect(screen.getByTestId("setup-suggestions-results")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Strijp-S" })).toBeTruthy();
		expect(
			screen.getByRole("checkbox", { name: "Participant verification" }),
		).toBeTruthy();
		expect(screen.getByTestId("setup-suggestions-status").textContent).toBe(
			"5 key terms suggested. 2 settings suggested.",
		);
		expect(screen.getByRole("button", { name: "Suggest again" })).toBeTruthy();
	});

	it("results with an unread link say so quietly", () => {
		renderBrief({
			notes: ["url_not_read"],
			status: "results",
			terms: SUGGESTIONS.key_terms,
		});
		expect(
			screen.getByTestId("setup-suggestions-url-note").textContent,
		).toContain("The link could not be read");
	});

	it("empty: one quiet line, no card", () => {
		renderBrief({ status: "results" });
		expect(screen.getByTestId("setup-suggestions-empty").textContent).toContain(
			"Nothing to suggest from this",
		);
		expect(screen.queryByTestId("setup-suggestions-results")).toBeNull();
	});

	it("error: a quiet line that says the host can carry on, never an alert", () => {
		renderBrief({ status: "error" });
		const line = screen.getByTestId("setup-suggestions-error");
		expect(line.textContent).toContain(
			"You can create the project without them.",
		);
		expect(screen.queryByRole("alert")).toBeNull();
		cleanup();
		renderBrief({ status: "error", surface: "portal_editor" });
		expect(screen.getByTestId("setup-suggestions-error").textContent).toContain(
			"You can add key terms yourself.",
		);
	});

	it("without inputs (portal editor): only the action and the results", () => {
		renderBrief({ showInputs: false });
		expect(screen.queryByLabelText("About your session")).toBeNull();
		expect(
			screen.getByRole("group", { name: "Suggested key terms" }),
		).toBeTruthy();
	});
});
