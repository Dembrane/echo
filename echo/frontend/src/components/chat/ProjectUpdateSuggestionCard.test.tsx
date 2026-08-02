// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ProjectUpdateSuggestion,
	ProjectUpdateSuggestionCard,
} from "./ProjectUpdateSuggestionCard";

// The card only needs the project read to decide "already applied"; leaving it
// undefined keeps it in the pending state, which is what we are testing.
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: undefined, refetch: vi.fn() }),
	useUpdateProjectByIdMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
}));

vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

	// MantineProvider reads the OS color scheme on mount; jsdom has no
	// matchMedia, so stub a minimal (always non-matching) implementation.
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

afterEach(() => {
	cleanup();
});

const renderCard = (
	suggestion: ProjectUpdateSuggestion,
	onSendNote?: (message: string) => void,
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ProjectUpdateSuggestionCard
					suggestion={suggestion}
					onSendNote={onSendNote}
				/>
			</MantineProvider>
		</I18nProvider>,
	);

const CURRENT_CONTEXT =
	"We are asking residents about the neighbourhood park, what they use it for, what keeps them away, and what they would change about it if the council asked.";
const PROPOSED_CONTEXT =
	"We are asking residents and shopkeepers about the neighbourhood park, what they use it for, what keeps them away, and what they would change about it if the council asked.";

const contextSuggestion: ProjectUpdateSuggestion = {
	changes: [
		{
			current: CURRENT_CONTEXT,
			field: "context",
			proposed: PROPOSED_CONTEXT,
			reason: "Shopkeepers were in the room and their answers get lost.",
		},
	],
	projectId: "project-1",
	summary: "One change to the project context.",
};

const twoFieldSuggestion: ProjectUpdateSuggestion = {
	changes: [
		contextSuggestion.changes[0],
		{
			current: "Old title",
			field: "default_conversation_title",
			proposed: "New title",
			reason: "Matches the poster.",
		},
	],
	projectId: "project-1",
	summary: "Two changes.",
};

describe("ProjectUpdateSuggestionCard", () => {
	it("rests collapsed, names the field and says it is waiting", () => {
		renderCard(contextSuggestion);
		expect(screen.getByText(/Waiting on you/)).toBeTruthy();
		expect(screen.getByText(/Project context/)).toBeTruthy();
		// The headline and the button say this already; the card does not
		// narrate itself a third time.
		expect(screen.queryByText(/Nothing changes until you accept/)).toBeNull();
		// The diff itself is not built until the host asks for it.
		expect(screen.queryByText("Current")).toBeNull();
		expect(screen.queryByText("Proposed")).toBeNull();
		expect(
			screen
				.getByTestId("suggestion-expand-button")
				.getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("offers accept, dismiss and a note from the resting state", () => {
		renderCard(contextSuggestion, vi.fn());
		expect(screen.getByTestId("suggestion-apply-button")).toBeTruthy();
		expect(screen.getByTestId("suggestion-dismiss-button")).toBeTruthy();
		expect(screen.getByTestId("suggestion-note-button")).toBeTruthy();
	});

	it("hides the note action when the chat cannot take one", () => {
		renderCard(contextSuggestion);
		expect(screen.queryByTestId("suggestion-note-button")).toBeNull();
	});

	it("shows the current value, the proposed value and what moved when expanded", () => {
		renderCard(contextSuggestion);
		fireEvent.click(screen.getByTestId("suggestion-expand-button"));

		expect(
			screen
				.getByTestId("suggestion-expand-button")
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(screen.getByText("Current")).toBeTruthy();
		expect(screen.getByText("Proposed")).toBeTruthy();
		// The added words are marked, and only on the proposed side.
		const added = screen.getAllByText("and shopkeepers", { exact: false });
		const marked = added.filter((node) =>
			node.className.includes("bg-green-100"),
		);
		expect(marked.length).toBe(1);
		// Both versions are readable in full, not just the new one: the shared
		// text appears once under Current and once under Proposed.
		expect(screen.getAllByText(/what keeps them away/).length).toBe(2);
		expect(screen.getByText(/words? added/)).toBeTruthy();
		// The reason gets its own line rather than being a throwaway label.
		expect(
			screen.getByText(
				"Shopkeepers were in the room and their answers get lost.",
			),
		).toBeTruthy();
	});

	it("keeps a short value on a plain before and after line", () => {
		renderCard({
			changes: [
				{
					current: "Old title",
					field: "default_conversation_title",
					proposed: "New title",
					reason: "Matches the poster.",
				},
			],
			projectId: "project-1",
			summary: "",
		});
		fireEvent.click(screen.getByTestId("suggestion-expand-button"));
		const removed = screen.getByText("Old title");
		const added = screen.getByText("New title");
		expect(removed.className).toContain("line-through");
		expect(added.className).toContain("text-green-900");
		// Both sides are marked before colour is decoded: the removal is struck
		// through, the addition sits on a background, same as the word diff.
		expect(removed.className).toContain("bg-red-100");
		expect(added.className).toContain("bg-green-100");
	});

	it("says what a change to the project context reaches, exactly once", () => {
		renderCard(contextSuggestion);
		const impact = /read by transcription, chat answers and canvas generation/;
		// Collapsed, the resting block is the only place it can be said.
		expect(screen.getAllByText(impact).length).toBe(1);

		// Expanded, the copy beside the field carries it and the resting one
		// stands down. Both used to render, the same sentence twice on one card.
		fireEvent.click(screen.getByTestId("suggestion-expand-button"));
		expect(screen.getAllByText(impact).length).toBe(1);

		fireEvent.click(screen.getByTestId("suggestion-expand-button"));
		expect(screen.getAllByText(impact).length).toBe(1);
	});

	it("does not offer to untick the only field there is", () => {
		renderCard(contextSuggestion);
		fireEvent.click(screen.getByTestId("suggestion-expand-button"));
		// Unticking the single field only disables Accept, which reads as a
		// broken card rather than a choice.
		expect(screen.queryByText(/Untick a field/)).toBeNull();
	});

	it("offers to untick a field once there is more than one", () => {
		renderCard(twoFieldSuggestion);
		fireEvent.click(screen.getByTestId("suggestion-expand-button"));
		expect(screen.getByText(/Untick a field/)).toBeTruthy();
	});

	it("gives the note the action row rather than stacking a second one", () => {
		renderCard(contextSuggestion, vi.fn());
		fireEvent.click(screen.getByTestId("suggestion-note-button"));

		expect(screen.getByTestId("suggestion-note-input")).toBeTruthy();
		// One submit on screen at a time: accept, dismiss and the expand toggle
		// stand down while the note is being written.
		expect(screen.queryByTestId("suggestion-apply-button")).toBeNull();
		expect(screen.queryByTestId("suggestion-dismiss-button")).toBeNull();
		expect(screen.queryByTestId("suggestion-expand-button")).toBeNull();

		fireEvent.click(screen.getByTestId("suggestion-note-cancel-button"));
		expect(screen.getByTestId("suggestion-apply-button")).toBeTruthy();
		expect(screen.queryByTestId("suggestion-note-input")).toBeNull();
	});

	it("lets a field be left out and blocks accept when nothing is ticked", () => {
		renderCard(twoFieldSuggestion);
		fireEvent.click(screen.getByTestId("suggestion-expand-button"));

		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes.length).toBe(2);
		fireEvent.click(checkboxes[0]);
		expect(screen.getByText(/1 of 2 fields selected/)).toBeTruthy();

		fireEvent.click(checkboxes[1]);
		expect(
			screen.getByTestId("suggestion-apply-button").hasAttribute("disabled"),
		).toBe(true);
	});

	it("collapses to a one-line record when dismissed, and can be reopened", () => {
		renderCard(contextSuggestion);
		fireEvent.click(screen.getByTestId("suggestion-dismiss-button"));
		expect(screen.getByText("Dismissed. Nothing was changed.")).toBeTruthy();
		expect(screen.queryByTestId("suggestion-apply-button")).toBeNull();

		fireEvent.click(screen.getByText("Review again"));
		expect(screen.getByTestId("suggestion-apply-button")).toBeTruthy();
	});

	it("sends the host's note back into the chat", () => {
		const onSendNote = vi.fn();
		renderCard(contextSuggestion, onSendNote);
		fireEvent.click(screen.getByTestId("suggestion-note-button"));
		fireEvent.change(screen.getByTestId("suggestion-note-input"), {
			target: { value: "Keep the shopkeepers out of it." },
		});
		fireEvent.click(screen.getByTestId("suggestion-note-send-button"));

		expect(onSendNote).toHaveBeenCalledTimes(1);
		expect(onSendNote.mock.calls[0][0]).toContain(
			"Keep the shopkeepers out of it.",
		);
	});
});
