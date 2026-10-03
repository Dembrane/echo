// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSidebarView } from "../hooks/useSidebarView";
import { AppBreadcrumbs } from "./AppBreadcrumbs";

// Mantine's hiddenFrom/visibleFrom read matchMedia, which jsdom lacks.
vi.stubGlobal(
	"matchMedia",
	vi.fn().mockImplementation((media: string) => ({
		addEventListener: vi.fn(),
		addListener: vi.fn(),
		dispatchEvent: vi.fn(),
		matches: false,
		media,
		onchange: null,
		removeEventListener: vi.fn(),
		removeListener: vi.fn(),
	})),
);
vi.mock("@/components/canvas/hooks", () => ({ useCanvas: () => ({}) }));
vi.mock("@/components/chat/hooks", () => ({ useChat: () => ({}) }));
vi.mock("@/components/conversation/hooks", () => ({
	useConversationById: () => ({}),
}));
vi.mock("@/components/project/hooks", () => ({ useProjectById: () => ({}) }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspaces: [] }),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));

i18n.load("en-US", {});
i18n.activate("en-US");
afterEach(cleanup);

it.each(["/release-notes", "/en-US/release-notes?year=2025"])(
	"gives %s a global sidebar and a breadcrumb back to Home",
	(path) => {
		const [pathname, search] = path.split("?");
		expect(resolveSidebarView(pathname, search)).toMatchObject({
			params: {},
			scope: "user",
			view: "user-home",
		});
		render(
			<MantineProvider>
				<I18nProvider i18n={i18n}>
					<MemoryRouter initialEntries={[path]}>
						<AppBreadcrumbs />
					</MemoryRouter>
				</I18nProvider>
			</MantineProvider>,
		);
		expect(
			screen.getByRole("link", { name: "Home" }).getAttribute("href"),
		).toBe("/en-US/o");
		expect(screen.getByText("Release notes")).toBeTruthy();
	},
);

it("labels /w/new as Create workspace, matching the page heading", () => {
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<MemoryRouter initialEntries={["/en-US/w/new?organisationId=org-1"]}>
					<AppBreadcrumbs />
				</MemoryRouter>
			</I18nProvider>
		</MantineProvider>,
	);
	expect(screen.getByText("Create workspace")).toBeTruthy();
	expect(screen.queryByText("Request workspace")).toBeNull();
});
