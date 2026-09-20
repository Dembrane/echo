// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
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
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
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
			<MantineProvider>
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
			</MantineProvider>
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

	it("counts the evidence the server counted, and its own where it must", () => {
		show({
			density: "check",
			item: {
				...popcorn,
				conversationCount: 9,
				edited: true,
				quoteCount: 12,
				verdict: "contested",
			},
		});
		// The server read the whole payload; the row's two source refs are the
		// fallback for a reader that carries no counts.
		expect(screen.getByText("12 quotes · 9 conversations")).toBeTruthy();
		const state = screen.getByTestId("result-state-obj-1").textContent ?? "";
		expect(state).toContain("the fact-check disagrees");
		expect(state).toContain("edited");
		cleanup();

		show({ density: "check", item: popcorn });
		expect(screen.getByText("2 quotes · 2 conversations")).toBeTruthy();
		expect(screen.queryByTestId("result-state-obj-1")).toBeNull();
	});

	it("names the one conversation a finding rests on, and says it once", () => {
		show({
			item: {
				...popcorn,
				attention: "one_conversation",
				conversationCount: 1,
				conversationName: "Marloes",
				quoteCount: 3,
			},
		});
		expect(screen.getByText("3 quotes from Marloes")).toBeTruthy();
		// The sentence already says there is one conversation.
		expect(screen.queryByText("one conversation only")).toBeNull();
		cleanup();

		show({
			item: {
				...popcorn,
				attention: "one_quote",
				conversationCount: 1,
				conversationName: "Marloes",
				quoteCount: 1,
			},
		});
		expect(screen.getByText("1 quote from Marloes")).toBeTruthy();
		expect(screen.queryByText("one quote only")).toBeNull();
	});

	it("counts alone where there is no name, and where there are several", () => {
		show({
			item: {
				...popcorn,
				attention: "one_conversation",
				conversationCount: 1,
				quoteCount: 2,
			},
		});
		expect(screen.getByText("2 quotes · 1 conversation")).toBeTruthy();
		expect(screen.getByText("one conversation only")).toBeTruthy();
		cleanup();

		show({
			item: {
				...popcorn,
				conversationCount: 3,
				conversationName: "Marloes",
				quoteCount: 5,
			},
		});
		expect(screen.getByText("5 quotes · 3 conversations")).toBeTruthy();
	});

	it("leaves the other attention phrases where they were", () => {
		show({
			item: {
				...popcorn,
				attention: "new",
				conversationCount: 1,
				conversationName: "Marloes",
				quoteCount: 1,
			},
		});
		expect(screen.getByText("new")).toBeTruthy();
		expect(screen.getByText("1 quote from Marloes")).toBeTruthy();
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

describe("what the row says once", () => {
	it("tags a stakeholder's rung, unless it is voiced", () => {
		const stakeholder = (rung: string): AnalysisObject => ({
			objectId: "obj-3",
			payload: { name: "The evening cleaners", role: "After six", rung },
			revisionId: "rev-b",
			type: "stakeholder",
		});
		show({ item: stakeholder("named") });
		expect(screen.getByText("Named by participants")).toBeTruthy();
		cleanup();

		show({ item: stakeholder("voiced") });
		expect(screen.queryByText("Named by participants")).toBeNull();
	});

	it("does not repeat a fact-check the row already rose for", () => {
		const argument: AnalysisObject = {
			attention: "fact_check",
			attributes: { assessment: { verdict: "contested" } },
			objectId: "obj-4",
			payload: { statement: "Open on Sundays", valence: "positive" },
			revisionId: "rev-c",
			type: "argument",
		};
		show({ density: "check", item: argument });
		expect(screen.getAllByText("the fact-check disagrees")).toHaveLength(1);
		cleanup();

		show({ density: "check", item: { ...argument, attention: null } });
		expect(screen.getByTestId("result-state-obj-4").textContent).toContain(
			"the fact-check disagrees",
		);
	});

	it("opens from anywhere in the row that is not a control of its own", () => {
		const onOpen = vi.fn();
		show({ onOpen });
		fireEvent.click(screen.getByText("2 quotes · 2 conversations"));
		expect(onOpen).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTestId("result-edit-phrase"));
		expect(onOpen).toHaveBeenCalledTimes(1);
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

		// Eleven characters is what the server would refuse, so nothing is sent
		// and the host reads the same line, never a number.
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "we agreed " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(editWords).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"A few more words, so someone reading later understands.",
			),
		).toBeTruthy();

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

	it("asks again, in the same words, when the server refuses the reason", async () => {
		editWords.mockRejectedValue(
			Object.assign(new Error("a few more words"), { status: 422 }),
		);
		show();
		const box = reword("We keep the library open on Sundays too");
		fireEvent.keyDown(box, { key: "Enter" });
		fireEvent.click(await screen.findByRole("button", { name: "The meaning" }));
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "Agreed in the second session" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(
			await screen.findByText(
				"A few more words, so someone reading later understands.",
			),
		).toBeTruthy();
		// Not a failed save, and the host's sentence is still in the field.
		expect(screen.queryByTestId("result-save-failed")).toBeNull();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"Agreed in the second session",
		);
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
				<MantineProvider>
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
				</MantineProvider>
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

	it("gives the row's actions as icons, with the words in the label", () => {
		show();
		const hold = screen.getByTestId("result-hold-back-obj-1");
		expect(hold.getAttribute("aria-label")).toBe("Not in this presentation");
		expect(hold.textContent).toBe("");
		expect(hold.querySelector("svg")).toBeTruthy();
		const open = screen.getByTestId("result-open-obj-1");
		expect(open.getAttribute("aria-label")).toBe("Open");
		cleanup();

		show({ open: true });
		expect(
			screen.getByTestId("result-open-obj-1").getAttribute("aria-label"),
		).toBe("Close");
	});

	it("offers three suggestions, each once, and always a way to say something else", () => {
		render(
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<ul>
						<ResultRow
							actions={{
								...actions(),
								heldBackReasons: [
									"said twice already",
									"off topic for this room",
								],
							}}
							canEdit
							density="curate"
							item={popcorn}
							onOpen={() => {}}
							open={false}
						/>
					</ul>
				</MantineProvider>
			</I18nProvider>,
		);
		fireEvent.click(screen.getByTestId("result-hold-back-obj-1"));
		const prompt = screen.getByTestId("result-hold-prompt-obj-1");
		expect(prompt.querySelectorAll("[data-option]")).toHaveLength(4);
		expect(
			screen.getAllByRole("button", { name: "off topic for this room" }),
		).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "another reason" }));
		// The question already asked why; the label does not ask again.
		expect(
			screen.getByLabelText(
				"One sentence, for the people you work with and anyone who checks later.",
			),
		).toBeTruthy();
	});
});
