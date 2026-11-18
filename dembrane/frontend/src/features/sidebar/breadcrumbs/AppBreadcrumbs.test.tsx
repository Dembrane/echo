// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useNavigate } from "react-router";
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
// What the mocked hooks answer; a test sets them, the rest see none.
const data = vi.hoisted(() => ({
	projectName: undefined as string | undefined,
	workspaces: [] as {
		id: string;
		name: string;
		org_id: string;
		org_name: string;
	}[],
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({
		data: data.projectName ? { name: data.projectName } : undefined,
	}),
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspaces: data.workspaces }),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));

i18n.load("en-US", {});
i18n.activate("en-US");
afterEach(() => {
	cleanup();
	data.projectName = undefined;
	data.workspaces = [];
});

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

const WORKSPACES = [
	{ id: "w1", name: "Wijkraad", org_id: "o1", org_name: "Gemeente Eindhoven" },
	{
		id: "w2",
		name: "Jongerenpanel",
		org_id: "o1",
		org_name: "Gemeente Eindhoven",
	},
];

// Navigates on demand, so a test can move the route under a mounted trail.
let go: (path: string) => void = () => {};
const Navigator = () => {
	const navigate = useNavigate();
	useEffect(() => {
		go = (path) => navigate(path);
	});
	return null;
};

const renderAt = (path: string) =>
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<MemoryRouter initialEntries={[path]}>
					<Navigator />
					<AppBreadcrumbs />
				</MemoryRouter>
			</I18nProvider>
		</MantineProvider>,
	);

const trail = () =>
	Array.from(
		document.querySelectorAll(
			'nav[aria-label="Breadcrumb"] a, nav[aria-label="Breadcrumb"] span',
		),
	)
		.map((el) => el.textContent?.trim())
		.filter(Boolean);

it("reads Home, organisation, workspace, project on a project page", () => {
	data.workspaces = WORKSPACES;
	data.projectName = "Strijp-S";
	renderAt("/en-US/w/w1/projects/p1/home");
	expect(screen.getByRole("link", { name: "Gemeente Eindhoven" })).toBeTruthy();
	expect(screen.getByRole("link", { name: "Wijkraad" })).toBeTruthy();
	expect(screen.getByText("Strijp-S")).toBeTruthy();
});

it("follows a move to another workspace without remounting", () => {
	data.workspaces = WORKSPACES;
	renderAt("/en-US/w/w1/home");
	expect(screen.getByText("Wijkraad")).toBeTruthy();

	act(() => go("/en-US/w/w2/home"));

	expect(screen.getByText("Jongerenpanel")).toBeTruthy();
	expect(screen.queryByText("Wijkraad")).toBeNull();
	expect(trail()).not.toContain("Wijkraad");
});
