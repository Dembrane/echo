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
vi.mock("@/components/analysis", () => ({
	EvidenceInspectionDrawer: () => null,
	useAnalysisObjects: () => ({}),
}));
vi.mock("@/components/present/AudienceScreen", () => ({
	AudienceScreen: () => <div>Room preview</div>,
}));
vi.mock("@/components/popcorn/PopcornOpeningSettings", () => ({
	PopcornOpeningSettings: () => <div>Opening settings</div>,
}));
vi.mock("@/components/popcorn/PopcornLanguageSettings", () => ({
	PopcornLanguageSettings: () => null,
}));
vi.mock("@/components/popcorn/PopcornScreenSettings", () => ({
	PopcornScreenSettings: () => null,
}));
vi.mock("@/components/popcorn/PopcornShare", () => ({
	PopcornShare: () => <div>Sharing settings</div>,
}));
vi.mock("@/components/popcorn/hooks", () => ({
	usePopcornLiveMutation: () => ({ mutate: vi.fn() }),
	usePopcornSettingsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
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
});
function show() {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={["/projects/empty/present"]}>
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
