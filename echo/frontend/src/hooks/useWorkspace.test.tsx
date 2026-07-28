// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	useWorkspace,
	useWorkspaceProvider,
	WorkspaceContext,
	type WorkspaceContextValue,
} from "./useWorkspace";

const WS_DEFAULT = "11111111-1111-4111-8111-111111111111";
const WS_TARGET = "22222222-2222-4222-8222-222222222222";

const workspaceSummary = (id: string, name: string, isDefault: boolean) => ({
	id,
	is_default: isDefault,
	logo_url: null,
	member_count: 1,
	name,
	org_id: "org-1",
	org_logo_url: null,
	org_name: "Org",
	project_count: 0,
	role: "admin",
	tier: "pioneer",
});

let workspacesFetchCount: number;
// Fetch #1 returns only the default workspace; later fetches also include the
// target, mimicking access granted after the list was first cached.
let targetVisibleFromFetch: number;

const jsonResponse = (body: unknown) =>
	({ json: async () => body, ok: true, status: 200 }) as Response;

beforeEach(() => {
	workspacesFetchCount = 0;
	targetVisibleFromFetch = Number.POSITIVE_INFINITY;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/v2/workspaces")) {
				workspacesFetchCount += 1;
				const workspaces = [workspaceSummary(WS_DEFAULT, "Default", true)];
				if (workspacesFetchCount >= targetVisibleFromFetch) {
					workspaces.push(workspaceSummary(WS_TARGET, "Customer", false));
				}
				return jsonResponse({ workspaces });
			}
			if (u.includes("/v2/me")) {
				return jsonResponse({
					avatar: null,
					directus_user_id: "du-1",
					display_name: "Staff",
					email: "staff@dembrane.com",
					has_legacy_projects: false,
					has_pending_invites: false,
					id: "au-1",
					is_staff: true,
					onboarding_answer_json: null,
					onboarding_completed: true,
					orgs: [],
					settings: {},
				});
			}
			return { json: async () => ({}), ok: false, status: 404 } as Response;
		}),
	);
	window.history.replaceState({}, "", "/");
	sessionStorage.clear();
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

let ctx: WorkspaceContextValue;

const Consumer = () => {
	ctx = useWorkspace();
	return <div data-testid="ws">{ctx.workspaceId ?? ""}</div>;
};

const Provider = ({ children }: PropsWithChildren) => {
	const value = useWorkspaceProvider(true);
	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
};

const renderProvider = () => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<Provider>
				<Consumer />
			</Provider>
		</QueryClientProvider>,
	);
};

it("re-reads the URL when setWorkspace repeats the already-selected id", async () => {
	// Stale-projects repro: a same-id setWorkspace after navigation used to bail
	// out of rendering, leaving the context stuck on the wrong workspace.
	const { getByTestId } = renderProvider();
	await waitFor(() => expect(getByTestId("ws").textContent).toBe(WS_DEFAULT));

	// Click: selection changes while the URL still points at the old page.
	act(() => ctx.setWorkspace(WS_TARGET));
	expect(getByTestId("ws").textContent).toBe(WS_DEFAULT);

	// Router finishes navigating; WorkspaceLayout re-fires the same id.
	window.history.pushState({}, "", `/w/${WS_TARGET}/home`);
	act(() => ctx.setWorkspace(WS_TARGET));
	expect(getByTestId("ws").textContent).toBe(WS_TARGET);
});

it("refetches the workspace list when the URL pins a workspace it does not contain", async () => {
	// Freshly granted access: the cached list lacks the workspace, so the
	// provider should refetch and resolve its name without a manual refresh.
	targetVisibleFromFetch = 2;
	window.history.replaceState({}, "", `/w/${WS_TARGET}/home`);
	const { getByTestId } = renderProvider();
	await waitFor(() => expect(getByTestId("ws").textContent).toBe(WS_TARGET));

	await waitFor(() => expect(ctx.workspaceName).toBe("Customer"));
	expect(workspacesFetchCount).toBe(2);
});
