// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Presentation } from "@/components/present/hooks";
import { PresentResultsPanel } from "./PresentResultsPanel";

vi.mock("@/lib/bff", () => ({
	bff: { get: vi.fn().mockResolvedValue({ revisions: [] }), post: vi.fn() },
}));
vi.mock("@/components/analysis", () => ({
	useResultsList: () => ({
		canEdit: true,
		counts: { popcorn: 1, tension: 1 },
		items: [
			{
				objectId: "obj-1",
				payload: { phrase: "A short phrase" },
				revisionId: "rev-1",
				type: "popcorn",
			},
			{
				objectId: "obj-2",
				payload: { poleA: "Open longer", poleB: "Pay people" },
				revisionId: "rev-2",
				type: "tension",
			},
		],
		loadingTypes: [],
		loadMore: () => {},
		total: 2,
	}),
	useResultsVisit: () => null,
}));
const save = vi.fn();
vi.mock("@/components/popcorn/hooks", () => ({
	usePopcornSettingsMutation: () => ({ mutate: save }),
}));

const presentation = {
	id: "screen",
	settings: { presentation: { blocks: ["popcorn"], hidden_items: [] } },
} as unknown as Presentation;

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
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function show(entry = "/present") {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<MemoryRouter initialEntries={[entry]}>
						<PresentResultsPanel
							projectId="project"
							presentation={presentation}
						/>
					</MemoryRouter>
				</MantineProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

describe("The results panel on its own", () => {
	it("groups the findings, and says which group the room will not see", () => {
		show();
		expect(screen.getByRole("region", { name: "Review results" })).toBeTruthy();
		expect(screen.getByText("A short phrase")).toBeTruthy();
		// The tensions block is off: the group stays, and says so in words.
		expect(screen.getByText("not in this presentation")).toBeTruthy();
		expect(screen.queryByText("Open longer")).toBeNull();
	});

	it("holds a finding back through the save it is given, and never closes", () => {
		show();
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		fireEvent.click(
			screen.getByRole("button", { name: "off topic for this room" }),
		);
		expect(save).toHaveBeenCalledWith({
			presentation: { hidden_items: ["obj-1"] },
		});
		// The panel is part of the dashboard: there is nothing to close.
		expect(
			screen.queryByRole("button", { name: "Close results review" }),
		).toBeNull();
	});

	it("opens the finding under its own row", () => {
		show();
		expect(screen.queryByTestId("result-item")).toBeNull();
		fireEvent.click(screen.getByTestId("result-open-obj-1"));
		expect(screen.getByTestId("result-item")).toBeTruthy();
	});
});
