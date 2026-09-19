// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { bff } from "@/lib/bff";
import { PresentRoute } from "./PresentRoute";

vi.mock("@/lib/bff", () => ({
	bff: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));
vi.mock("@/hooks/useServerEvents", () => ({ useServerEvents: vi.fn() }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
const results = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock("@/components/analysis", () => ({
	EvidenceInspectionDrawer: () => null,
	useAnalysisObjects: () => results(),
}));
// The preview scales the room's screen to the column it sits in, so the column
// has to have a width here.
vi.mock("@mantine/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mantine/hooks")>()),
	useElementSize: () => ({ height: 405, ref: { current: null }, width: 720 }),
}));
vi.mock("@/components/present/AudienceScreen", () => ({
	AudienceScreen: () => <div>Room preview</div>,
}));
vi.mock("@/components/popcorn/PopcornOpeningSettings", () => ({
	PopcornOpeningSettings: () => <div>Opening settings</div>,
}));
vi.mock("@/components/popcorn/PopcornLanguageSettings", () => ({
	PopcornAlsoLanguages: () => <div data-testid="popcorn-language-also" />,
	PopcornLanguageSettings: () => null,
}));
vi.mock("@/components/popcorn/PopcornScreenSettings", () => ({
	PopcornScreenSettings: () => null,
}));
vi.mock("@/components/popcorn/PopcornShare", () => ({
	PopcornShare: () => <div>Sharing settings</div>,
}));
const saveSettings = vi.fn();
vi.mock("@/components/popcorn/hooks", () => ({
	usePopcornLiveMutation: () => ({ mutate: vi.fn() }),
	usePopcornSettingsMutation: () => ({
		mutate: saveSettings,
		mutateAsync: vi.fn(),
	}),
	usePopcornStopLiveMutation: () => ({ mutate: vi.fn() }),
}));

const presentation = {
	counts: { phrases: 0 },
	effective_language: { translate_to: "en", ui: "en" },
	id: "empty-screen",
	loop: { mode: "manual" },
	name: "Workshop",
	project_language: { code: "en", fallback: null },
	settings: {
		presentation: {
			blocks: ["popcorn"],
			hidden_items: [],
			language_policy: "project",
			opening: "popcorn",
		},
		title: "Workshop",
	},
};
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});
beforeEach(() => {
	vi.mocked(bff.get).mockImplementation(async (url) => {
		if (url.endsWith("/draft"))
			return { has_changes: false, presentation, revision: 0 };
		if (url.endsWith("/updates")) return { available: false };
		return { can_edit: true, presentation };
	});
	vi.mocked(bff.post).mockResolvedValue(presentation);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	results.mockReturnValue({});
});
function show(entry = "/projects/empty/present") {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={[entry]}>
						<Routes>
							<Route
								path="/projects/:projectId/present"
								element={<PresentRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
}
describe("Preparing the room before recordings", () => {
	it("creates a presentation without starting analysis, then opens the full editor", async () => {
		vi.mocked(bff.get).mockImplementation(async (url) => {
			if (url.endsWith("/draft"))
				return { has_changes: false, presentation, revision: 0 };
			if (url.endsWith("/updates")) return { available: false };
			return { can_edit: true, presentation: null };
		});
		show();
		expect(await screen.findByText("Presentation editor")).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Intro" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Data policy" })).toBeTruthy();
		expect(bff.post).toHaveBeenCalledExactlyOnceWith(
			"/present/projects/empty/default",
		);
	});
	it("keeps Go live and Share beside Present, and opens the screen without a processing request", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		show();
		const present = await screen.findByRole("button", {
			name: "Present",
		});
		expect(screen.getByRole("button", { name: "Go live" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
		fireEvent.click(present);
		expect(open).toHaveBeenCalledWith(
			"/present/screen/empty-screen",
			"_blank",
			"noopener",
		);
		expect(bff.post).not.toHaveBeenCalled();
	});
	it("scales the room's screen down instead of squeezing it into the column", async () => {
		show();
		const stage = await screen.findByTestId("present-preview-stage");
		expect(stage.style.transform).toBe("scale(0.5)");
		expect(stage.style.width).toBe("1440px");
		expect(stage.style.height).toBe("810px");
	});

	it("does not create a presentation for a read-only host", async () => {
		vi.mocked(bff.get).mockResolvedValue({
			can_edit: false,
			presentation: null,
		});
		show();
		await waitFor(() =>
			expect(
				screen.getByText("The host hasn’t prepared a presentation yet."),
			).toBeTruthy(),
		);
		expect(bff.post).not.toHaveBeenCalled();
	});
});

const editing = () => show("/projects/empty/present?edit=1");

const openPanel = async (name: string) => {
	fireEvent.click(await screen.findByRole("button", { name }));
};

describe("Choosing what the room sees", () => {
	it("opens with Popcorn, which cannot be switched off or swapped for another tab", async () => {
		editing();
		// The accessible name is the label and its description together.
		const popcorn = (await screen.findByRole("switch", {
			name: /^Popcorn/,
		})) as HTMLInputElement;
		expect(popcorn.checked).toBe(true);
		fireEvent.click(popcorn);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"Always on. The screen opens here, so the room has something to read while the rest gets ready.",
			),
		).toBeTruthy();
		expect(screen.queryByLabelText("Open with")).toBeNull();
		expect(
			screen.queryByText("Select a tab to show results on the screen."),
		).toBeNull();
	});

	it("still lets another tab be added, and never sends an opening tab", async () => {
		editing();
		const tensions = await screen.findByRole("switch", { name: /^Tensions/ });
		fireEvent.click(tensions);
		expect(saveSettings).toHaveBeenCalledWith({
			presentation: { blocks: ["popcorn", "tensions"] },
		});
		expect(
			saveSettings.mock.calls.some((call) => "opening" in call[0].presentation),
		).toBe(false);
	});
});

describe("Reviewing the results on the screen", () => {
	const items = [
		{ label: "A short phrase", objectId: "obj-1", type: "popcorn" },
		{ label: "Another phrase", objectId: "obj-2", type: "popcorn" },
	];

	it("puts edit and hide on the row as named icons, and pages with a pager", async () => {
		results.mockReturnValue({
			data: { items, limit: 100, snapshotId: "snap-1", total: 250 },
		});
		editing();
		await openPanel("Review visible results");
		expect(
			screen.queryByRole("button", { name: "Evidence and history" }),
		).toBeNull();
		expect(
			screen.getAllByRole("button", {
				name: "Edit wording, see evidence and history",
			}),
		).toHaveLength(2);
		fireEvent.click(
			screen.getAllByRole("button", {
				name: "Hide from this presentation",
			})[0],
		);
		expect(saveSettings).toHaveBeenCalledWith({
			presentation: { hidden_items: ["obj-1"] },
		});
		expect(screen.getByRole("button", { name: "3" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Next results" })).toBeNull();
	});

	it("offers the way back for hidden findings, with the count", async () => {
		const hidden = {
			...presentation,
			settings: {
				...presentation.settings,
				presentation: {
					...presentation.settings.presentation,
					hidden_items: ["obj-1"],
				},
			},
		};
		vi.mocked(bff.get).mockImplementation(async (url) => {
			if (url.endsWith("/draft"))
				return { has_changes: false, presentation: hidden, revision: 0 };
			if (url.endsWith("/updates")) return { available: false };
			return { can_edit: true, presentation: hidden };
		});
		results.mockReturnValue({
			data: { items, limit: 100, snapshotId: "snap-1", total: 2 },
		});
		editing();
		await openPanel("Review visible results");
		expect(
			screen.getByRole("button", { name: "Show in this presentation" }),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Reset hidden findings (1)" }),
		);
		expect(saveSettings).toHaveBeenCalledWith({
			presentation: { hidden_items: [] },
		});
	});
});

describe("Telling the host how far the translation got", () => {
	it("reports the count under the language controls", async () => {
		const translating = {
			...presentation,
			translation_status: {
				detail: null,
				pending: 3,
				state: "translating",
				target: "nl",
				total: 12,
				translated: 9,
			},
		};
		vi.mocked(bff.get).mockImplementation(async (url) => {
			if (url.endsWith("/draft"))
				return { has_changes: false, presentation: translating, revision: 0 };
			if (url.endsWith("/updates")) return { available: false };
			return { can_edit: true, presentation: translating };
		});
		editing();
		await openPanel("Language");
		expect(
			await screen.findByText("Translating: 9 of 12 into Nederlands"),
		).toBeTruthy();
		// Following the project language still leaves the extra languages on offer.
		expect(screen.getByTestId("popcorn-language-also")).toBeTruthy();
	});
});
