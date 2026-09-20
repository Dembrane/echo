// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
import { bff } from "@/lib/bff";
import { ResultItem } from "./ResultItem";

vi.mock("@/lib/bff", () => ({ bff: { get: vi.fn(), post: vi.fn() } }));

const popcorn: AnalysisObject = {
	objectId: "obj-1",
	payload: { phrase: "We keep the library open", question: false },
	provenance: {
		origin: "generated",
		recipeId: "popcorn",
		sourceRefs: [
			{ conversationId: "c-1", quote: "The library is the one warm room." },
			{ conversationId: "c-1", quote: "We come here every week." },
			{ conversationId: "c-2", quote: "My children learned to read here." },
			{ conversationId: "c-3", quote: "Closing it would be the end." },
		],
	},
	revisionId: "rev-2",
	type: "popcorn",
};

const revisions = [
	{
		membershipExcluded: false,
		objectId: "obj-1",
		payload: { phrase: "We keep the libary open" },
		provenance: { origin: "generated" },
		publishedAt: "2026-09-18T09:00:00Z",
		revisionId: "rev-1",
		revisionNumber: 1,
		status: "published",
		type: "popcorn",
	},
	{
		actorId: "user-1",
		changeKind: "typo",
		membershipExcluded: false,
		objectId: "obj-1",
		payload: { phrase: "We keep the library open" },
		provenance: { origin: "authored" },
		publishedAt: "2026-09-19T09:00:00Z",
		reason: null,
		revisionId: "rev-2",
		revisionNumber: 2,
		status: "published",
		type: "popcorn",
	},
];

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	vi.mocked(bff.get).mockResolvedValue({ object: {}, revisions });
	vi.mocked(bff.post).mockResolvedValue({ revision: revisions[1] });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function show(props: Partial<Parameters<typeof ResultItem>[0]> = {}) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<ResultItem projectId="project-1" item={popcorn} {...props} />
				</MemoryRouter>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

describe("the stage card", () => {
	it("gives each kind its own shape", () => {
		show();
		expect(screen.getByText("We keep the library open")).toBeTruthy();
		cleanup();

		show({
			item: {
				objectId: "obj-2",
				payload: {
					knot: "Opening hours against staffing",
					poleA: "Open longer",
					poleB: "Pay people properly",
					toResolve: "What do we fund first?",
				},
				revisionId: "rev-a",
				type: "tension",
			},
		});
		expect(screen.getByText("Open longer")).toBeTruthy();
		expect(screen.getByText("Pay people properly")).toBeTruthy();
		expect(screen.getByText("Opening hours against staffing")).toBeTruthy();
		expect(screen.getByText(/What do we fund first\?/)).toBeTruthy();
		cleanup();

		show({
			item: {
				objectId: "obj-3",
				payload: {
					name: "The evening cleaners",
					role: "Keep the building open after six",
					rung: "named",
					stake: "Their shifts end with the last reader",
				},
				revisionId: "rev-b",
				type: "stakeholder",
			},
		});
		expect(screen.getByText("The evening cleaners")).toBeTruthy();
		expect(screen.getByText("Keep the building open after six")).toBeTruthy();
		expect(screen.getByText("Named by participants")).toBeTruthy();
		cleanup();

		show({
			item: {
				objectId: "obj-4",
				payload: {
					statement: "The library should stay open on Sundays",
					valence: "positive",
				},
				revisionId: "rev-c",
				type: "argument",
			},
		});
		expect(
			screen.getByText("The library should stay open on Sundays"),
		).toBeTruthy();
		expect(screen.getByText("For")).toBeTruthy();
	});

	it("steps the type size by length and never cuts the words", () => {
		const long = "a".repeat(300);
		show({
			item: {
				objectId: "obj-5",
				payload: { phrase: long },
				revisionId: "rev-d",
				type: "popcorn",
			},
		});
		const finding = screen.getByText(long);
		expect(finding.className).toContain("size3");
		expect(finding.textContent).toHaveLength(300);
		cleanup();

		show();
		expect(screen.getByText("We keep the library open").className).toContain(
			"size1",
		);
	});

	it("shows at most three quotes and counts all the evidence", () => {
		show();
		expect(screen.getByTestId("result-quotes").children).toHaveLength(3);
		expect(screen.getByText("4 quotes · 3 conversations")).toBeTruthy();
	});

	it("marks a reworded finding, and leaves a generated one unmarked", () => {
		show();
		expect(screen.queryByTestId("result-edited")).toBeNull();
		cleanup();

		show({
			item: {
				...popcorn,
				provenance: { ...popcorn.provenance, origin: "authored" },
			},
		});
		expect(screen.getByTestId("result-edited")).toBeTruthy();
		cleanup();

		// Withdrawing is authored too, and changes no words.
		show({
			item: {
				...popcorn,
				provenance: {
					...popcorn.provenance,
					extra: { changeKind: "withdraw" },
					origin: "authored",
				},
			},
		});
		expect(screen.queryByTestId("result-edited")).toBeNull();
	});
});

describe("the workbench margin", () => {
	it("is there for a host who may edit, and absent for a reader", () => {
		show();
		expect(screen.queryByTestId("result-workbench")).toBeNull();
		cleanup();

		show({ canEdit: true });
		expect(screen.getByTestId("result-workbench")).toBeTruthy();
	});

	it("shows who, when, the kind, and 'not recorded' where none was kept", async () => {
		show({ actorName: () => "Anna", canEdit: true });
		expect(await screen.findByTestId("result-history")).toBeTruthy();
		expect(screen.getByText("A typo")).toBeTruthy();
		expect(screen.getByText("Kind of change not recorded")).toBeTruthy();
		expect(screen.getByText(/Anna ·/)).toBeTruthy();
		expect(screen.getByText(/dembrane ·/)).toBeTruthy();
		// The before and after of the wording that changed: struck through in
		// the entry that replaced it, and plain in the entry that produced it.
		const before = screen.getAllByText("We keep the libary open");
		expect(before).toHaveLength(2);
		expect(before[0].className).toContain("before");
	});

	it("will not withdraw without a reason, and sends the kind with it", async () => {
		show({ canEdit: true });
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		const step = await screen.findByTestId("result-withdraw-reason");
		expect(step).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		expect(
			screen.getByText(
				"A few more words, so someone reading later understands.",
			),
		).toBeTruthy();
		expect(bff.post).not.toHaveBeenCalled();

		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "It repeats the finding above it" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		await waitFor(() => expect(bff.post).toHaveBeenCalled());
		expect(vi.mocked(bff.post).mock.calls[0][0]).toContain("/membership");
		expect(vi.mocked(bff.post).mock.calls[0][1]).toEqual({
			change_kind: "withdraw",
			excluded: true,
			expected_revision_id: "rev-2",
			reason: "It repeats the finding above it",
		});
	});

	it("takes a short reason for a withdrawal, and asks again if the server will not", async () => {
		show({ canEdit: true });
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		await screen.findByTestId("result-withdraw-reason");
		// Four characters is what the server takes for a withdrawal: a host who
		// has said it is never stopped here.
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "dupe" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		await waitFor(() => expect(bff.post).toHaveBeenCalled());
		expect(
			screen.queryByText(
				"A few more words, so someone reading later understands.",
			),
		).toBeNull();
	});

	it("asks for more words where the server refused the reason", async () => {
		vi.mocked(bff.post).mockRejectedValueOnce(
			Object.assign(new Error("a few more words"), { status: 422 }),
		);
		show({ canEdit: true });
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		await screen.findByTestId("result-withdraw-reason");
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "dupe" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		expect(
			await screen.findByText(
				"A few more words, so someone reading later understands.",
			),
		).toBeTruthy();
		// The step is still open, with the host's words in it.
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"dupe",
		);
	});

	it("gives the caret back to the control that opened the reason step", async () => {
		show({ canEdit: true });
		fireEvent.click(
			screen.getByRole("button", { name: "Withdraw from the analysis" }),
		);
		await screen.findByTestId("result-withdraw-reason");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(document.activeElement?.textContent).toBe(
				"Withdraw from the analysis",
			),
		);
	});

	it("changes the words on the card, with the list's own prompt", async () => {
		const editWords = vi.fn().mockResolvedValue({ revisionId: "rev-3" });
		show({
			canEdit: true,
			onEditWords: { editWords, undoWords: vi.fn() },
		});
		fireEvent.click(screen.getByTestId("result-edit-phrase"));
		fireEvent.change(screen.getByTestId("result-words-phrase"), {
			target: { value: "We keep the library opn" },
		});
		fireEvent.keyDown(screen.getByTestId("result-words-phrase"), {
			key: "Enter",
		});
		fireEvent.click(await screen.findByRole("button", { name: "A typo" }));
		await waitFor(() => expect(editWords).toHaveBeenCalled());
		expect(editWords.mock.calls[0][0]).toMatchObject({
			changeKind: "typo",
			expectedRevisionId: "rev-2",
			field: "phrase",
			words: "We keep the library opn",
		});
	});

	it("restores a wording against the revision it came from", async () => {
		show({ canEdit: true });
		const restore = await screen.findByRole("button", {
			name: "Restore this wording",
		});
		fireEvent.click(restore);
		await waitFor(() => expect(bff.post).toHaveBeenCalled());
		expect(vi.mocked(bff.post).mock.calls[0][0]).toContain("/rollback");
		expect(vi.mocked(bff.post).mock.calls[0][1]).toMatchObject({
			change_kind: "rollback",
			expected_revision_id: "rev-2",
			to_revision_id: "rev-1",
		});
	});
});
