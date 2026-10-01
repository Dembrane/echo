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
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CreateWorkspaceRoute } from "./CreateWorkspaceRoute";

/** The access step's wall. The two non-open options need a paid plan, and the
 * agreed shape is a popover on an enabled looking control rather than a
 * disabled card with a standing line under it. */

const capture = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
		getFeatureFlag: () => undefined,
		getFeatureFlagPayload: () => undefined,
		onFeatureFlags: () => () => {},
	},
}));

vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({
		data: {
			email: "someone@example.org",
			onboarding_completed: true,
			orgs: [{ id: "org-1", name: "Example Org", role: "admin" }],
		},
		isLoading: false,
	}),
}));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ setWorkspace: vi.fn(), workspace: undefined }),
}));

vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => vi.fn(),
}));

vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: { email: "someone@example.org" } }),
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

	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		} as unknown as typeof ResizeObserver;
	}
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

beforeEach(() => {
	capture.mockClear();
	sessionStorage.clear();
	// The organisation is on the free plan, which is what closes the two
	// non-open options.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.includes("/billing") ? { tier: "free" } : [];
			return new Response(JSON.stringify(body), {
				headers: { "Content-Type": "application/json" },
				status: 200,
			});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const openAccessStep = async () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({
							defaultOptions: { queries: { retry: false } },
						})
					}
				>
					<MemoryRouter initialEntries={["/w/new?organisationId=org-1"]}>
						<CreateWorkspaceRoute />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

	fireEvent.change(await screen.findByLabelText("Workspace name"), {
		target: { value: "Client Alpha" },
	});
	fireEvent.click(screen.getByText("Next"));
	fireEvent.click(screen.getByText("Next"));
	await screen.findByTestId("create-workspace-access-everyone");
};

it("opens the wall on a blocked access option instead of selecting it", async () => {
	await openAccessStep();

	const gated = screen.getByTestId("create-workspace-access-just_me");
	// Enabled looking: the click has somewhere to go.
	expect(gated.hasAttribute("disabled")).toBe(false);
	// The standing line is gone. The popover carries the words now.
	expect(screen.queryByText("Available on a paid plan.")).toBeNull();

	fireEvent.click(gated);

	const popover = await screen.findByTestId("feature-gate-popover");
	expect(popover.textContent).toContain(
		"Private workspaces come with a paid plan.",
	);
	// The selection never moved.
	expect(gated.getAttribute("aria-pressed")).toBe("false");
	expect(
		screen
			.getByTestId("create-workspace-access-everyone")
			.getAttribute("aria-pressed"),
	).toBe("true");
});

it("reports the access wall, once, and not the other wall on the page", async () => {
	await openAccessStep();

	fireEvent.click(screen.getByTestId("create-workspace-access-invite"));
	fireEvent.click(screen.getByTestId("create-workspace-access-invite"));
	fireEvent.click(screen.getByTestId("create-workspace-access-invite"));

	await waitFor(() =>
		expect(
			capture.mock.calls.filter(
				(call) => call[0] === "pricing_config_gate_viewed",
			),
		).toHaveLength(1),
	);
	const [, props] = capture.mock.calls.find(
		(call) => call[0] === "pricing_config_gate_viewed",
	) as [string, Record<string, unknown>];
	// Not `workspace_cap`, which is the other wall on this route and belongs to
	// the 402 on submit.
	expect(props.wall_key).toBe("private_workspace");
	expect(props.surface).toBe("popover");
	expect(props.required_tier).toBe("innovator");
});

it("still selects an option that is not blocked", async () => {
	await openAccessStep();

	const open = screen.getByTestId("create-workspace-access-everyone");
	expect(open.getAttribute("aria-pressed")).toBe("true");
	fireEvent.click(open);
	expect(open.getAttribute("aria-pressed")).toBe("true");
	expect(screen.queryByTestId("feature-gate-popover")).toBeNull();
});
