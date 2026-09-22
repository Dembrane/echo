// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Presentation } from "@/components/present/hooks";
import { PresentResultsPanel } from "./PresentResultsPanel";

const offsets: number[] = [];
vi.mock("@/components/analysis", () => ({
	EvidenceInspectionDrawer: () => null,
	useAnalysisObjects: (
		_project: string,
		_type: undefined,
		_state: string,
		offset: number,
	) => {
		offsets.push(offset);
		return {
			data: {
				items: [
					{ label: "A short phrase", objectId: "obj-1", type: "popcorn" },
					{ label: "A tension", objectId: "obj-2", type: "tension" },
				],
				limit: 100,
				snapshotId: "snap-1",
				total: 250,
			},
		};
	},
}));
const save = vi.fn();
vi.mock("@/components/popcorn/hooks", () => ({
	usePopcornSettingsMutation: () => ({ mutate: save }),
}));

const presentation = {
	id: "screen",
	settings: { presentation: { blocks: ["popcorn"], hidden_items: [] } },
} as unknown as Presentation;

function Where() {
	return <output>{useLocation().search}</output>;
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
});
afterEach(() => {
	cleanup();
	offsets.length = 0;
	vi.clearAllMocks();
});

function show(entry: string, onClose = vi.fn()) {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[entry]}>
					<PresentResultsPanel
						projectId="project"
						presentation={presentation}
						onClose={onClose}
					/>
					<Where />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	return onClose;
}

describe("The results panel on its own", () => {
	it("lists only results of tabs the room can open, under its own heading", () => {
		show("/present");
		expect(screen.getByRole("region", { name: "Review results" })).toBeTruthy();
		expect(screen.getByText("A short phrase")).toBeTruthy();
		expect(screen.queryByText("A tension")).toBeNull();
	});

	it("reads its page from the address and writes it back", () => {
		show("/present?results=1&resultsPage=1");
		expect(offsets[0]).toBe(100);
		fireEvent.click(screen.getByRole("button", { name: "3" }));
		expect(screen.getByRole("status").textContent).toBe(
			"?results=1&resultsPage=2",
		);
	});

	it("hides a finding through the save it is given, and closes on request", () => {
		const onClose = show("/present");
		fireEvent.click(
			screen.getByRole("button", { name: "Hide from this presentation" }),
		);
		expect(save).toHaveBeenCalledWith({
			presentation: { hidden_items: ["obj-1"] },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Close results review" }),
		);
		expect(onClose).toHaveBeenCalled();
	});
});
