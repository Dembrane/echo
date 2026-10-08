// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationsMiniList } from "./ConversationsMiniList";

const navigate = vi.hoisted(() => vi.fn());
const role = vi.hoisted(() => ({ current: "owner" }));
const extra = vi.hoisted(() => ({ conversations: [] as object[] }));

vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
	}),
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: () => null,
}));
vi.mock("./useConversationList", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useConversationList: () => ({
		activeFiltersCount: 0,
		allConversations: [
			{ created_at: null, id: "c1", live: true, title: "Table 1" },
			{ created_at: null, id: "c2", title: "Table 2" },
			{ created_at: null, has_transcript: false, id: "c3", title: "Table 3" },
			...extra.conversations,
		],
		conversationsCountQuery: { data: 3 },
		conversationsQuery: { isFetchingNextPage: false, isLoading: false },
		hasActiveFilters: false,
		search: "",
		selectedTagIds: [],
		showOnlyVerified: false,
		sortBy: "-created_at",
		tagOptions: [],
	}),
}));

i18n.load("en-US", {});
i18n.activate("en-US");

beforeAll(() => {
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
	navigate.mockReset();
	role.current = "owner";
	extra.conversations = [];
});

const renderList = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter>
					<ConversationsMiniList projectId="p1" workspaceId="w1" withTitle />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

describe("ConversationsMiniList", () => {
	it("asks about the ticked conversations, and only once one is ticked", () => {
		renderList();
		expect(screen.queryByRole("button", { name: /Ask about/ })).toBeNull();
		expect(screen.getByText("Live")).toBeTruthy();

		fireEvent.click(screen.getByRole("checkbox", { name: "Select Table 1" }));
		expect(screen.getByRole("button", { name: "Ask about this" })).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Table 2" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Ask about these (2)" }),
		);

		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/p1/chats/new", {
			state: { selectedConversationIds: ["c1", "c2"] },
		});
	});

	it("can't tick an empty conversation", () => {
		renderList();
		expect(
			(
				screen.getByRole("checkbox", {
					name: "Select Table 3",
				}) as HTMLInputElement
			).disabled,
		).toBe(true);
	});

	it("shows no checkboxes to a role that can't ask", () => {
		role.current = "observer";
		renderList();
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.getByRole("link", { name: /Table 1/ })).toBeTruthy();
	});

	it("shows transcribing while recording or while chunks wait for a transcript", () => {
		// Stored flags are unset on older rows, so the status reads the chunks.
		extra.conversations = [
			{
				created_at: null,
				has_pending_chunks: false,
				id: "c4",
				is_all_chunks_transcribed: null,
				is_audio_processing_finished: false,
				is_finished: true,
				title: "Transcribed",
			},
			{
				created_at: null,
				has_pending_chunks: true,
				id: "c5",
				is_finished: true,
				title: "Pending",
			},
			{
				created_at: null,
				has_pending_chunks: false,
				id: "c6",
				is_finished: false,
				title: "Unfinished",
			},
			{
				created_at: null,
				has_pending_chunks: false,
				id: "c7",
				is_finished: false,
				last_chunk_at: null,
				title: "Nothing recorded",
			},
		];
		renderList();
		const status = (title: string) =>
			screen.getByRole("link", { name: new RegExp(title) }).textContent;
		expect(status("Transcribed")).toContain("Done");
		expect(status("Transcribed")).not.toContain("Transcribing");
		expect(status("Pending")).toContain("Transcribing");
		expect(status("Unfinished")).toContain("Transcribing");
		expect(status("Nothing recorded")).toContain("Empty");
		expect(status("Nothing recorded")).not.toContain("Transcribing");
	});
});
