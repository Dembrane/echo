// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { PortalEditorRoute } from "./PortalEditorRoute";

// The portal editor hands its page one project per id and save: a refetch
// that changed nothing keeps the page's project, a save brings the new one.
const state = vi.hoisted(() => ({
	data: undefined as unknown,
	seen: [] as unknown[],
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: state.data, error: null, isLoading: false }),
	useVerificationTopicsQuery: () => ({
		data: undefined,
		error: null,
		isLoading: false,
	}),
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { id: "w1", role: "owner" } }),
}));
vi.mock("./i18n", () => ({ useSettingsCatalog: () => true }));
vi.mock("./PortalSectionEditor/PortalSectionEditor", () => ({
	PortalSectionEditor: ({ project }: { project: Project }) => {
		state.seen.push(project);
		return <div data-testid="page">{project.updated_at}</div>;
	},
}));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(() => {
	cleanup();
	state.seen = [];
});

const tree = (section = "about") => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<MemoryRouter initialEntries={[`/p/p1/portal/${section}`]}>
				<Routes>
					<Route path="/p/:projectId/portal">
						<Route path="welcome" element={<p>home</p>} />
						<Route path=":section" element={<PortalEditorRoute />} />
					</Route>
				</Routes>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);

it("keeps the page's project through a refetch, and takes a saved one", () => {
	state.data = { id: "p1", tags: [], updated_at: "t1" };
	const view = render(tree());
	const first = state.seen.at(-1);

	state.data = { id: "p1", tags: [], updated_at: "t1" };
	view.rerender(tree());
	expect(state.seen.at(-1)).toBe(first);

	state.data = { id: "p1", tags: [], updated_at: "t2" };
	view.rerender(tree());
	expect(screen.getByTestId("page").textContent).toBe("t2");
});

it("sends an unknown page to the welcome page", () => {
	state.data = { id: "p1", tags: [], updated_at: "t1" };
	render(tree("nope"));
	expect(screen.getByText("home")).toBeTruthy();
});
