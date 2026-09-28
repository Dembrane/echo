// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisObject } from "@/components/analysis/hooks";
import type { PresentationBlock } from "@/components/present/blocks";
import type { ResultActions } from "../useResultActions";
import { CuratePanel } from "./CuratePanel";

// The rating counts on the click and the request follows, so the requests here
// are left in flight: what is being read is what the host sees at once.
const put = vi.fn().mockImplementation(() => new Promise(() => {}));
const remove = vi.fn().mockImplementation(() => new Promise(() => {}));
const post = vi.fn();

vi.mock("@/lib/bff", () => ({
	bff: {
		delete: (...args: unknown[]) => remove(...args),
		get: vi.fn().mockResolvedValue({ revisions: [] }),
		post: (...args: unknown[]) => post(...args),
		put: (...args: unknown[]) => put(...args),
	},
}));

const pop = (index: number): AnalysisObject =>
	({
		conversationName: `Conversation ${index}`,
		detail: {
			evidence: [
				{
					conversationId: `c${index}`,
					label: `Conversation ${index}`,
					quotes: [`And then phrase ${index} came up.`],
				},
			],
		},
		objectId: `p${index}`,
		payload: { phrase: `phrase ${index}` },
		revisionId: `rev-p${index}`,
		type: "popcorn",
	}) as AnalysisObject;

const edited = vi.fn().mockResolvedValue({ revisionId: "rev-p1-b" });

function useTestActions(): ResultActions {
	const [held, setHeld] = useState<string[]>([]);
	return {
		editWords: edited,
		heldBackReasons: [],
		heldReason: () => undefined,
		holdBack: (objectId: string) =>
			setHeld((old) => [...new Set([...old, objectId])]),
		holdBackMany: () => {},
		isHeld: (objectId: string) => held.includes(objectId),
		pending: false,
		showAgain: (objectId: string) =>
			setHeld((old) => old.filter((id) => id !== objectId)),
		undoWords: vi.fn(),
	} as unknown as ResultActions;
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function Panel({ items }: { items: AnalysisObject[] }) {
	const actions = useTestActions();
	const [selected, setSelected] = useState<PresentationBlock>("popcorn");
	return (
		<CuratePanel
			actions={actions}
			analysisHref="/analysis"
			blocks={["popcorn", "tensions", "map", "stakeholders"]}
			canEdit
			items={items}
			onSelect={setSelected}
			projectId="project"
			selected={selected}
		/>
	);
}

function show(items = [pop(1)]) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<MemoryRouter>
						<Panel items={items} />
					</MemoryRouter>
				</MantineProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

describe("The tools on a row", () => {
	it("gives every finding the same five, each with a name", () => {
		show();
		const tools = screen.getByTestId("curate-tools-p1");
		expect(tools.children.length).toBe(5);
		for (const name of [
			"Good finding",
			"Not a good finding",
			"Hide from this presentation",
			"Edit",
			"Open in Analysis",
		])
			expect(screen.getByLabelText(name)).toBeTruthy();
	});

	it("keeps a tool that is on in view, and never moves one", () => {
		show();
		const eye = screen.getByLabelText("Hide from this presentation");
		// Hidden is opacity, not display: the tool keeps its place and its turn
		// in the tab order whether or not the row is under the pointer.
		expect(eye.parentElement?.className).toContain("tools");
		fireEvent.click(eye);
		const shown = screen.getByLabelText("Show again");
		expect(shown.dataset.on).toBe("true");
		expect(screen.getByTestId("curate-tools-p1").children.length).toBe(5);
	});

	it("opens the whole picture as a link, not a button", () => {
		show();
		const open = screen.getByLabelText("Open in Analysis");
		expect(open.tagName).toBe("A");
		expect(open.getAttribute("href")).toContain("/analysis");
	});
});

describe("Hiding from this presentation", () => {
	it("hides in one click, greys the row, and says so on the control", () => {
		show();
		fireEvent.click(screen.getByLabelText("Hide from this presentation"));
		expect(screen.getByTestId("curate-pop-p1")).toHaveProperty(
			"dataset.held",
			"true",
		);
		expect(
			screen.getByLabelText("Show again").getAttribute("aria-pressed"),
		).toBe("true");
		// No prompt, no quiet line, no countdown.
		expect(screen.queryByText("add a reason")).toBeNull();
		expect(screen.queryByText("Undo")).toBeNull();
	});

	it("shows the finding again on the same glyph", () => {
		show();
		fireEvent.click(screen.getByLabelText("Hide from this presentation"));
		fireEvent.click(screen.getByLabelText("Show again"));
		expect(screen.getByTestId("curate-pop-p1").dataset.held).toBeUndefined();
	});
});

describe("Thumbs", () => {
	it("rates on the click, colours the thumb, and opens the offer", async () => {
		show();
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Good finding"));
		});
		expect(screen.getByLabelText("Good finding").dataset.on).toBe("true");
		expect(put).toHaveBeenCalled();
		expect(screen.getByText("Leave feedback")).toBeTruthy();
	});

	it("keeps the two thumbs exclusive, and clears on the same thumb again", async () => {
		show();
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Good finding"));
		});
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Not a good finding"));
		});
		expect(screen.getByLabelText("Good finding").dataset.on).toBeUndefined();
		expect(screen.getByLabelText("Not a good finding").dataset.on).toBe("true");
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Not a good finding"));
		});
		expect(
			screen.getByLabelText("Not a good finding").dataset.on,
		).toBeUndefined();
		expect(remove).toHaveBeenCalled();
		expect(screen.queryByText("Leave feedback")).toBeNull();
	});

	it("sends the ticks and the words as stable keys, then thanks the host", async () => {
		show();
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Good finding"));
		});
		fireEvent.click(screen.getByTestId("curate-tag-recognizable"));
		// The field is there only for the tick that needs it.
		expect(screen.queryByTestId("curate-feedback-note")).toBeNull();
		fireEvent.click(screen.getByTestId("curate-tag-other"));
		fireEvent.change(screen.getByTestId("curate-feedback-note"), {
			target: { value: "it named the night shift" },
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId("curate-feedback-send"));
		});
		expect(put).toHaveBeenLastCalledWith(
			expect.stringContaining("/feedback"),
			expect.objectContaining({
				note: "it named the night shift",
				rating: "up",
				tags: ["recognizable", "other"],
			}),
		);
		expect(screen.getByTestId("curate-feedback-thanks")).toBeTruthy();
	});

	it("offers the two ways on after a thumb down", async () => {
		show();
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Not a good finding"));
		});
		fireEvent.click(screen.getByTestId("curate-tag-tone_deaf"));
		await act(async () => {
			fireEvent.click(screen.getByTestId("curate-feedback-send"));
		});
		expect(put).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ rating: "down", tags: ["tone_deaf"] }),
		);
		expect(screen.getByTestId("curate-feedback-hide-p1")).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByTestId("curate-feedback-hide-p1"));
		});
		expect(screen.getByTestId("curate-pop-p1")).toHaveProperty(
			"dataset.held",
			"true",
		);
	});

	it("counts a rating the host never says more about", async () => {
		show();
		await act(async () => {
			fireEvent.click(screen.getByLabelText("Good finding"));
		});
		expect(put).toHaveBeenCalledTimes(1);
		expect(screen.getByLabelText("Good finding").dataset.on).toBe("true");
	});
});

describe("Edit mode", () => {
	it("is the pencil's job, not the words'", () => {
		show();
		fireEvent.click(screen.getByText("phrase 1"));
		expect(screen.queryByTestId("curate-words-phrase")).toBeNull();
		fireEvent.click(screen.getByLabelText("Edit"));
		expect(screen.getByTestId("curate-words-phrase")).toBeTruthy();
	});

	it("gives the words back on Escape, and sends nothing", () => {
		show();
		fireEvent.click(screen.getByLabelText("Edit"));
		const box = screen.getByTestId("curate-words-phrase");
		fireEvent.change(box, { target: { value: "phrase one" } });
		fireEvent.keyDown(box, { key: "Escape" });
		expect(screen.queryByTestId("curate-words-phrase")).toBeNull();
		expect(edited).not.toHaveBeenCalled();
		expect(screen.getByText("phrase 1")).toBeTruthy();
	});

	it("asks what changed on Enter, and saves what the host answers", async () => {
		show();
		fireEvent.click(screen.getByLabelText("Edit"));
		const box = screen.getByTestId("curate-words-phrase");
		fireEvent.change(box, { target: { value: "phrase one" } });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.getByTestId("curate-change-p1")).toBeTruthy();
		// "A typo" needs no sentence, so the answer is the save.
		await act(async () => {
			fireEvent.click(screen.getByText("A typo"));
		});
		expect(edited).toHaveBeenCalledWith(
			expect.objectContaining({
				changeKind: "typo",
				field: "phrase",
				objectId: "p1",
				words: "phrase one",
			}),
		);
	});

	it("leaves edit mode without a word when nothing changed", () => {
		show();
		fireEvent.click(screen.getByLabelText("Edit"));
		fireEvent.click(screen.getByLabelText("Edit"));
		expect(screen.queryByTestId("curate-words-phrase")).toBeNull();
		expect(screen.queryByTestId("curate-change-p1")).toBeNull();
		expect(edited).not.toHaveBeenCalled();
	});
});
