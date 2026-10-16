// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LegacyProjectRedirect,
	mapLegacyProjectPath,
} from "./LegacyProjectRedirect";

vi.mock("@/components/common/BeautifulLoading", () => ({
	BeautifulLoading: () => <div>loading</div>,
}));

const P = "11111111-2222-4333-8444-555555555555";
const C = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const W = "99999999-8888-4777-8666-555555555555";

const Where = () => {
	const { pathname, search } = useLocation();
	return <div data-testid="where">{pathname + search}</div>;
};

// Same shape as mainRouter: an optional language, a catch-all error page.
const land = async (url: string) => {
	const router = createMemoryRouter(
		[
			{
				children: [
					{ element: <LegacyProjectRedirect />, path: "projects" },
					{
						element: <LegacyProjectRedirect />,
						path: "projects/:projectId/*",
					},
					{ element: <div>error page</div>, path: "*" },
					{ element: <Where />, path: "" },
					{ element: <Where />, path: "w/:workspaceId/*" },
				],
				path: "/:language?",
			},
		],
		{ initialEntries: [url] },
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return (await screen.findByTestId("where")).textContent;
};

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (url: string) =>
		url.endsWith(`/v2/projects/${P}`)
			? new Response(JSON.stringify({ id: P, workspace_id: W }))
			: new Response("{}", { status: 404 }),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("legacy /projects links", () => {
	it("sends /projects home, keeping the language", async () => {
		expect(await land("/en-US/projects")).toBe("/en-US/");
		cleanup();
		expect(await land("/projects")).toBe("/");
	});

	it("opens the same project in its workspace", async () => {
		expect(await land(`/nl-NL/projects/${P}/overview`)).toBe(
			`/nl-NL/w/${W}/projects/${P}/overview`,
		);
	});

	it("maps the old conversation transcript to the conversation", async () => {
		expect(
			await land(`/en-US/projects/${P}/conversation/${C}/transcript?x=1`),
		).toBe(`/en-US/w/${W}/projects/${P}/conversations/${C}?x=1`);
	});

	it("goes home for a project the account cannot see", async () => {
		const other = "00000000-0000-4000-8000-000000000000";
		expect(await land(`/en-US/projects/${other}/overview`)).toBe("/en-US/");
	});

	it("goes home for paths that are not a project", async () => {
		expect(await land("/en-US/projects/login")).toBe("/en-US/");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("mapLegacyProjectPath", () => {
	it.each([
		["", "home"],
		["overview", "overview"],
		["portal-editor", "portal-editor"],
		[`chats/${C}`, `chats/${C}`],
		[`conversation/${C}`, `conversations/${C}`],
		[`conversation/${C}/overview`, `conversations/${C}`],
		[`conversation/${C}/debug`, `conversations/${C}/debug`],
		["library/views/v1/aspects/a1", "library"],
		["report", "report"],
		["report/r1", "report"],
		["overview/extra/deep", "overview"],
		[`chats/${C}/debug`, `chats/${C}/debug`],
		["canvases", "home"],
		["conversation", "conversations"],
		["something-retired", "home"],
	])("%s -> %s", (from, to) => {
		expect(mapLegacyProjectPath(from)).toBe(to);
	});
});
