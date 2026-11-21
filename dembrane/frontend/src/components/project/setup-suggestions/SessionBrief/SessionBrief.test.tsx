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
	onToggleSetting: vi.fn(),
	onToggleTerm: vi.fn(),
	onUrlChange: vi.fn(),
	settings: [],
	status: "idle",
	surface: "wizard",
	terms: [],
	totalTerms: 0,
	withLink: true,
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
	it("idle: one action and no text field of its own, with a walkthrough anchor", () => {
		const props = renderBrief();
		const group = screen.getByRole("group", { name: "Suggested key terms" });
		expect(group.getAttribute("data-tour")).toBe("setup-suggestions");
		expect(screen.queryByRole("textbox", { name: /session/i })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Suggest key terms" }));
		expect(props.onSuggest).toHaveBeenCalled();
		expect(screen.queryByTestId("setup-suggestions-results")).toBeNull();
	});

	it("the link sits behind Add a link, collapsed by default", () => {
		const props = renderBrief();
		const toggle = screen.getByRole("button", { name: "Add a link" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		fireEvent.change(screen.getByLabelText(/Link to a page about it/), {
			target: { value: "https://example.org" },
		});
		expect(props.onUrlChange).toHaveBeenCalledWith("https://example.org");
	});

	it("a link already given keeps the field open", () => {
		renderBrief({ url: "https://example.org" });
		expect(
			screen
				.getByRole("button", { name: "Add a link" })
				.getAttribute("aria-expanded"),
		).toBe("true");
	});

	it("without anything to read, the action waits and says what to do", () => {
		renderBrief({ canSuggest: false, hint: "Describe your session first." });
		expect(
			screen.getByTestId("setup-suggestions-submit").hasAttribute("disabled"),
		).toBe(true);
		expect(screen.getByTestId("setup-suggestions-hint").textContent).toBe(
			"Describe your session first.",
		);
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

	it("a long context says plainly that only its start was read and the whole is saved", () => {
		renderBrief({ readStartOnly: true, status: "loading" });
		expect(
			screen.getByTestId("setup-suggestions-long-note").textContent,
		).toContain("The whole text is saved.");
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
		expect(screen.getByTestId("setup-suggestions-error").textContent).toContain(
			"You can create the project without them.",
		);
		expect(screen.queryByRole("alert")).toBeNull();
		cleanup();
		renderBrief({ status: "error", surface: "portal_editor", withLink: false });
		expect(screen.getByTestId("setup-suggestions-error").textContent).toContain(
			"You can add key terms yourself.",
		);
		expect(screen.queryByRole("button", { name: "Add a link" })).toBeNull();
	});
});
