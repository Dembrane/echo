// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Protected } from "@/components/common/Protected";
import {
	lastWorkspaceKey,
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { NewProjectRedirect } from "./NewProjectRedirect";

vi.mock("@/components/common/BeautifulLoading", () => ({
	BeautifulLoading: () => <div>loading</div>,
}));

const session = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth")>()),
	hasSession: async () => session.active,
	signOut: async () => {},
}));

const USER = "user-1";
const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-3333-4333-8333-cccccccccccc";

const workspace = (id: string, is_default = false) =>
	({ id, is_default }) as WorkspaceContextValue["workspaces"][number];

const Where = () => {
	const { pathname, search, hash } = useLocation();
	return <div data-testid="where">{pathname + search + hash}</div>;
};

const land = async (
	url: string,
	workspaces: WorkspaceContextValue["workspaces"],
) => {
	const router = createMemoryRouter(
		[
			{
				children: [
					{
						element: (
							<Protected>
								<NewProjectRedirect />
							</Protected>
						),
						path: "projects/new",
					},
					{ element: <Where />, path: "" },
					{ element: <Where />, path: "login" },
					{ element: <Where />, path: "onboarding" },
					{ element: <Where />, path: "w/:workspaceId/*" },
				],
				path: "/:language?",
			},
		],
		{ initialEntries: [url] },
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<WorkspaceContext.Provider
				value={
					{
						isError: false,
						isLoading: false,
						workspaces,
					} as WorkspaceContextValue
				}
			>
				<RouterProvider router={router} />
			</WorkspaceContext.Provider>
		</QueryClientProvider>,
	);
	return (await screen.findByTestId("where")).textContent;
};

beforeEach(() => {
	session.active = true;
	localStorage.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
			url.endsWith("/v2/me")
				? new Response(JSON.stringify({ directus_user_id: USER }))
				: new Response("{}", { status: 404 }),
		),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("/projects/new", () => {
	it("opens project creation in the last-used workspace", async () => {
		localStorage.setItem(lastWorkspaceKey(USER), B);
		expect(await land("/projects/new", [workspace(A), workspace(B)])).toBe(
			`/w/${B}/projects/new`,
		);
	});

	it("falls back to the first workspace when none is stored", async () => {
		expect(await land("/projects/new", [workspace(A), workspace(B)])).toBe(
			`/w/${A}/projects/new`,
		);
	});

	it("ignores a stored workspace the person no longer has", async () => {
		localStorage.setItem(lastWorkspaceKey(USER), C);
		expect(await land("/projects/new", [workspace(A), workspace(B)])).toBe(
			`/w/${A}/projects/new`,
		);
	});

	it("goes to onboarding without a workspace", async () => {
		expect(await land("/projects/new", [])).toBe("/onboarding");
	});

	it("keeps ?next through login when signed out", async () => {
		session.active = false;
		const where = await land("/projects/new?utm=mail", [workspace(A)]);
		// The login page adds the active language prefix itself.
		expect(where).toMatch(/\/login\?next=/);
		const next = new URLSearchParams(where?.split("?").slice(1).join("?")).get(
			"next",
		);
		expect(next).toBe("/projects/new?utm=mail");
	});

	it("keeps the language, search and hash", async () => {
		expect(await land("/nl-NL/projects/new?utm=mail#top", [workspace(A)])).toBe(
			`/nl-NL/w/${A}/projects/new?utm=mail#top`,
		);
	});
});
