// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MouseEventHandler, ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { WorkspaceHomeView } from "./WorkspaceHomeView";

const cap = vi.hoisted(() => ({ at: false }));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspaces: [
			{ id: "w1", name: "W", org_id: "o1", role: "owner", tier: "free" },
		],
	}),
}));
vi.mock("@/hooks/useWorkspaceProjects", () => ({
	useWorkspaceProjects: () => ({ data: undefined }),
}));
vi.mock("@/hooks/useProjectCap", () => ({ useProjectCap: () => cap.at }));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({ opened, wallKey }: { opened: boolean; wallKey: string }) =>
		opened ? <div data-testid="upgrade-modal" data-wall={wallKey} /> : null,
}));
vi.mock("../../primitives/NavItem", () => ({
	NavItem: ({
		to,
		label,
		onClick,
	}: {
		to: string;
		label: ReactNode;
		onClick?: MouseEventHandler<HTMLAnchorElement>;
	}) => (
		<a href={to} onClick={onClick}>
			{label}
		</a>
	),
}));
vi.mock("../../primitives/BackButton", () => ({ BackButton: () => null }));
vi.mock("../../shell/rail", () => ({
	FullOnly: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	cap.at = false;
});

const renderView = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/w/w1/home"]}>
					<Routes>
						<Route
							path="/w/:workspaceId/home"
							element={<WorkspaceHomeView />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const createLink = () => screen.getByText("Create project").closest("a");

it("links to the wizard below the cap, with no unavailable mark", () => {
	renderView();
	const link = createLink();
	expect(link?.getAttribute("href")).toBe("/w/w1/projects/new");
	expect(fireEvent.click(link as HTMLAnchorElement)).toBe(true);
	expect(screen.queryByTestId("unavailable-info")).toBeNull();
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("at the cap marks Create project unavailable and opens the wall in place", () => {
	cap.at = true;
	renderView();
	const link = createLink() as HTMLAnchorElement;
	expect(link.querySelector('[data-testid="unavailable-info"]')).toBeTruthy();
	// false: the navigation was prevented.
	expect(fireEvent.click(link)).toBe(false);
	expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe("project_cap");
});
