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
import { CreateOrganisationModal } from "./CreateOrganisationModal";

const fetchMock = vi.fn();
const notifyError = vi.fn();
const onClose = vi.fn();
const activeWorkspace = vi.hoisted(() => ({
	current: null as null | { id: string; role: string; tier: string },
}));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: activeWorkspace.current }),
}));

vi.mock("@/components/error/notifyError", () => ({
	notifyError: (err: unknown) => notifyError(err),
}));

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		currentTier,
		opened,
		orgId,
		wallKey,
		requiredTier,
		workspaceId,
	}: {
		currentTier: string;
		opened: boolean;
		orgId?: string;
		wallKey: string;
		requiredTier: string;
		workspaceId: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-tier={requiredTier}
				data-current={currentTier}
				data-org={orgId ?? ""}
				data-workspace={workspaceId}
			/>
		) : null,
}));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

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
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
	notifyError.mockReset();
	onClose.mockReset();
	activeWorkspace.current = null;
});

afterEach(() => {
	cleanup();
});

const renderModal = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter>
						<CreateOrganisationModal opened onClose={onClose} />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const submit = async () => {
	fireEvent.change(
		await screen.findByTestId("create-organisation-name-input"),
		{
			target: { value: "Acme" },
		},
	);
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
};

const orgLimit = (blocking: Record<string, string> = {}) =>
	answer(402, {
		code: "billing.tier_limit",
		detail: {
			...blocking,
			error: "FREE_TIER_LIMIT",
			limit: "organisations",
			upgrade_cta_tier: "changemaker",
		},
		params: { limit: "organisations" },
	});

it("opens the upgrade modal on the organisations limit, not an error toast", async () => {
	fetchMock.mockResolvedValue(orgLimit());
	renderModal();
	await submit();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("org_cap");
	expect(modal.dataset.tier).toBe("changemaker");
	expect(notifyError).not.toHaveBeenCalled();
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("shows the wall as free even from a paid workspace", async () => {
	activeWorkspace.current = { id: "ws-paid", role: "owner", tier: "guardian" };
	fetchMock.mockResolvedValue(orgLimit());
	renderModal();
	await submit();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.current).toBe("free");
});

it("still toasts any other failure", async () => {
	fetchMock.mockResolvedValue(answer(500, { detail: "boom" }));
	renderModal();
	await submit();
	await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1));
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("targets the blocking free org, not the active paid workspace", async () => {
	activeWorkspace.current = { id: "ws-paid", role: "owner", tier: "guardian" };
	fetchMock.mockResolvedValue(
		orgLimit({ org_id: "org-free", workspace_id: "ws-free" }),
	);
	renderModal();
	await submit();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.org).toBe("org-free");
	expect(modal.dataset.workspace).toBe("ws-free");
});

it("falls back to the active workspace when the refusal names none", async () => {
	activeWorkspace.current = { id: "ws-active", role: "owner", tier: "free" };
	fetchMock.mockResolvedValue(orgLimit());
	renderModal();
	await submit();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.org).toBe("");
	expect(modal.dataset.workspace).toBe("ws-active");
});
