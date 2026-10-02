// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AcceptInviteRoute } from "./AcceptInviteRoute";

const navigate = vi.fn();

vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigate,
}));

vi.mock("@/components/auth/hooks", () => ({
	useAuthenticated: () => ({ isAuthenticated: true, loading: false }),
	useCurrentUser: () => ({ data: { email: "invitee@example.org" } }),
	useLogoutMutation: () => ({ isPending: false, mutate: () => {} }),
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
	navigate.mockReset();
	vi.unstubAllGlobals();
});

const stubByHash = (status: number, body: unknown) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(body), { status })),
	);

const renderRoute = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter
						initialEntries={[
							"/invite/accept?h=abc&ws=Team&email=invitee%40example.org",
						]}
					>
						<AcceptInviteRoute />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

it("sends a signed-in user who has not onboarded to onboarding", async () => {
	stubByHash(403, { code: "access.not_onboarded" });
	renderRoute();

	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith("/onboarding", { replace: true }),
	);
	expect(
		screen.queryByText("This invite link isn't valid for this account"),
	).toBeNull();
});

it("still says not valid when the invite is not found", async () => {
	stubByHash(200, { status: "not_found" });
	renderRoute();

	expect(
		await screen.findByText("This invite link isn't valid for this account"),
	).toBeTruthy();
	expect(navigate).not.toHaveBeenCalled();
});
