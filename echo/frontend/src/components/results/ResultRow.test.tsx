// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { ResultRow } from "./ResultRow";
import type { ResultActions } from "./useResultActions";

const popcorn: AnalysisObject = {
	objectId: "obj-1",
	payload: { phrase: "We keep the library open" },
	provenance: {
		sourceRefs: [
			{ conversationId: "c-1", quote: "The library is the one warm room." },
			{ conversationId: "c-2", quote: "We come here every week." },
		],
	},
	revisionId: "rev-2",
	type: "popcorn",
};

const editWords = vi.fn();
const undoWords = vi.fn();
const holdBack = vi.fn();
const showAgain = vi.fn();
let held: string[] = [];

const actions = (): ResultActions => ({
	editWords,
	heldBackReasons: [],
	holdBack,
	isHeld: (objectId) => held.includes(objectId),
	pending: false,
	showAgain,
	undoWords,
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	held = [];
	editWords.mockResolvedValue({ revisionId: "rev-3" });
	undoWords.mockResolvedValue({ revisionId: "rev-4" });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function show(props: Partial<Parameters<typeof ResultRow>[0]> = {}) {
	return render(
		<I18nProvider i18n={i18n}>
			<ul>
				<ResultRow
					actions={actions()}
					canEdit
					density="curate"
					item={popcorn}
					onOpen={() => {}}
					open={false}
					{...props}
				/>
			</ul>
		</I18nProvider>,
	);
}

/** Click the words, replace them, and let them go. */
function reword(words: string, field = "phrase") {
	fireEvent.click(screen.getByTestId(`result-edit-${field}`));
	const box = screen.getByTestId(`result-words-${field}`);
	fireEvent.change(box, { target: { value: words } });
	return box;
}

describe("one skeleton, four fillings", () => {
	it("gives each kind its own lines and counts its evidence", () => {
		show();
		expect(screen.getByText("We keep the library open")).toBeTruthy();
		expect(screen.getByText("2 quotes · 2 conversations")).toBeTruthy();
		cleanup();

		show({
			item: {
				objectId: "obj-2",
				payload: {
					knot: "Opening hours against staffing",
					poleA: "Open longer",
					poleB: "Pay people properly",
				},
				revisionId: "rev-a",
				type: "tension",
			},
		});
		expect(screen.getByText("Open longer")).toBeTruthy();
		expect(screen.getByText("Pay people properly")).toBeTruthy();
		expect(screen.getByText("Opening hours against staffing")).toBeTruthy();
		cleanup();

		show({
			item: {
				objectId: "obj-3",
				payload: {
					name: "The evening cleaners",
					role: "Keep the building open",
				},
				revisionId: "rev-b",
				type: "stakeholder",
			},
		});
		expect(screen.getByText("The evening cleaners")).toBeTruthy();
		expect(screen.getByText("Keep the building open")).toBeTruthy();
		cleanup();

		show({
			item: {
				objectId: "obj-4",
				payload: { statement: "Open on Sundays", valence: "positive" },
				revisionId: "rev-c",
				type: "argument",
			},
		});
		expect(screen.getByText("Open on Sundays")).toBeTruthy();
		expect(screen.getByText("for")).toBeTruthy();
	});

	it("says the state in words in the check density, and nowhere else", () => {
		const edited = {
			...popcorn,
			provenance: { ...popcorn.provenance, origin: "authored" },
		};
		show({ density: "check", item: edited });
		expect(screen.getByTestId("result-state-obj-1").textContent).toContain(
			"edited",
		);
		cleanup();

		show({ item: edited });
		expect(screen.queryByTestId("result-state-obj-1")).toBeNull();
	});
});

describe("changing the words in place", () => {
	it("asks what changed, and blur never discards", async () => {
		show();
		const box = reword("We keep the library opn");
		fireEvent.blur(box);
		// Nothing has been sent, and the new words wait where they stand.
		expect(editWords).not.toHaveBeenCalled();
		expect(await screen.findByText("What did you change?")).toBeTruthy();
		expect(screen.getByText("We keep the library opn")).toBeTruthy();
	});

	it("rests on 'A typo' for a small change, so Enter, Enter finishes it", async () => {
		show();
		const box = reword("We keep the library opn");
		fireEvent.keyDown(box, { key: "Enter" });
		const typo = await screen.findByRole("button", { name: "A typo" });
		expect(document.activeElement).toBe(typo);
		fireEvent.click(typo);
		expect(editWords).toHaveBeenCalledWith({
			changeKind: "typo",
			expectedRevisionId: "rev-2",
			field: "phrase",
			objectId: "obj-1",
			payload: { phrase: "We keep the library open" },
			reason: undefined,
			words: "We keep the library opn",
		});
		expect(await screen.findByTestId("result-saved")).toBeTruthy();
	});

	it("will not take a change of meaning without a sentence", async () => {
		show();
		const box = reword("We keep the library open on Sundays too");
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.click(await screen.findByRole("button", { name: "The meaning" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(
			screen.getByText(
				"A few more words, so someone reading later understands.",
			),
		).toBeTruthy();
		expect(editWords).not.toHaveBeenCalled();

		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "The Sunday opening was agreed in the second session" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(editWords).toHaveBeenCalledWith(
			expect.objectContaining({
				changeKind: "meaning",
				reason: "The Sunday opening was agreed in the second session",
			}),
		);
	});

	it("gives the caret back to the words when the step is called off", async () => {
		show();
		const box = reword("We keep the library opn");
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		// The old words are back, nothing was sent, and the caret is on them.
		expect(editWords).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByTestId("result-edit-phrase"),
			),
		);
	});

	it("undoes against the revision its own edit produced", async () => {
		show();
		const box = reword("We keep the library opn");
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.click(await screen.findByRole("button", { name: "A typo" }));
		fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
		expect(undoWords).toHaveBeenCalledWith({
			// The revision the edit produced, so anyone else's edit conflicts.
			expectedRevisionId: "rev-3",
			objectId: "obj-1",
			toRevisionId: "rev-2",
		});
	});

	it("shows both wordings when someone else got there first", async () => {
		editWords.mockRejectedValue(
			Object.assign(new Error("HTTP 409"), {
				detail: {
					current: {
						actorId: "user-2",
						payload: { phrase: "We keep the library open longer" },
						publishedAt: new Date(Date.now() - 120000).toISOString(),
						revisionId: "rev-9",
					},
				},
				status: 409,
			}),
		);
		show({ actorName: () => "Anna" });
		const box = reword("We keep the library opn");
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.click(await screen.findByRole("button", { name: "A typo" }));
		const choice = await screen.findByTestId("result-conflict-choice");
		expect(choice.textContent).toContain("We keep the library open longer");
		expect(choice.textContent).toContain("Anna");
		expect(choice.textContent).toContain("We keep the library opn");
	});

	it("keeps the host's words when the save fails", async () => {
		editWords.mockRejectedValue(new Error("nope"));
		show();
		const box = reword("We keep the library opn");
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.click(await screen.findByRole("button", { name: "A typo" }));
		expect(await screen.findByTestId("result-save-failed")).toBeTruthy();
		expect(
			(screen.getByTestId("result-words-phrase") as HTMLTextAreaElement).value,
		).toBe("We keep the library opn");
	});
});

describe("holding a finding back", () => {
	it("asks a reason before it goes, and dims the row where it stands", () => {
		const { rerender } = show();
		fireEvent.click(screen.getByTestId("result-hold-back-obj-1"));
		expect(screen.getByText("Why not in this presentation?")).toBeTruthy();
		expect(holdBack).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "off topic for this room" }),
		);
		expect(holdBack).toHaveBeenCalledWith("obj-1", "off topic for this room");

		held = ["obj-1"];
		rerender(
			<I18nProvider i18n={i18n}>
				<ul>
					<ResultRow
						actions={actions()}
						canEdit
						density="curate"
						item={popcorn}
						onOpen={() => {}}
						open={false}
					/>
				</ul>
			</I18nProvider>,
		);
		expect(screen.getByTestId("result-row-obj-1").closest("li")).toHaveProperty(
			"dataset.held",
			"true",
		);
		expect(
			screen.getByRole("button", { name: "Put back in this presentation" }),
		).toBeTruthy();
	});
});
