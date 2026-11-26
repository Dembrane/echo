// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { AuthLayout } from "./AuthLayout";

// A signed-in person who opens a sign-in link with ?next= (the demo email's button).
const navigate = vi.fn();
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/auth/hooks", () => ({
	useAuthenticated: () => ({ isAuthenticated: true, loading: false }),
}));
vi.mock("@/components/language/LanguagePicker", () => ({
	LanguagePicker: () => null,
}));

const WS = "0a1b2c3d-0000-4000-8000-000000000001";
const ORG = "0a1b2c3d-0000-4000-8000-0000000000aa";
const PROJECT = `/en-US/w/${WS}/projects/0a1b2c3d-0000-4000-8000-0000000000bb/overview`;

const context = (
	over: Partial<WorkspaceContextValue>,
): WorkspaceContextValue => ({
	clearWorkspace: () => {},
	isError: false,
	isLoading: false,
	refetch: () => {},
	setWorkspace: () => {},
	workspace: null,
	workspaceId: null,
	workspaceName: null,
	workspaces: [],
	...over,
});

const tree = (next: string, value: WorkspaceContextValue) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<WorkspaceContext.Provider value={value}>
				<MemoryRouter
					initialEntries={[`/login?next=${encodeURIComponent(next)}`]}
				>
					<AuthLayout />
				</MemoryRouter>
			</WorkspaceContext.Provider>
		</MantineProvider>
	</I18nProvider>
);
const show = (next: string, value: WorkspaceContextValue) =>
	render(tree(next, value));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	navigate.mockReset();
});

describe("a signed-in person on a sign-in link", () => {
	const mine = [{ id: WS, name: "dembrane demo", org_id: ORG }] as never;

	it("goes to the project in a workspace they are in", async () => {
		show(PROJECT, context({ workspaces: mine }));
		await waitFor(() => expect(navigate).toHaveBeenCalledWith(PROJECT));
	});

	it("waits for their workspaces before deciding", async () => {
		const view = show(PROJECT, context({ isLoading: true }));
		// Effects have run once the layout is on screen: nothing was decided yet.
		await act(async () => {});
		expect(navigate).not.toHaveBeenCalled();
		view.rerender(tree(PROJECT, context({ workspaces: mine })));
		await waitFor(() => expect(navigate).toHaveBeenCalledWith(PROJECT));
	});

	it("goes home from a link to a workspace they are not in", async () => {
		show(PROJECT, context({ workspaces: [] }));
		await waitFor(() => expect(navigate).toHaveBeenCalledWith("/o"));
	});
});
