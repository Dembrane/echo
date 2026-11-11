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
type Ws = {
	id: string;
	org_id: string;
	tier: string;
	is_default?: boolean;
	bills_separately?: boolean;
};
const ctx = vi.hoisted(() => ({
	me: null as null | {
		is_staff: boolean;
		orgs: Array<{ id: string; name: string; role: string }>;
	},
	workspaces: [] as Ws[],
}));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: activeWorkspace.current,
		workspaces: ctx.workspaces,
	}),
}));

vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: ctx.me }),
}));

vi.mock("@/components/error/notifyError", () => ({
	notifyError: (err: unknown) => notifyError(err),
}));

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		currentTier,
		onClose,
		opened,
		orgId,
		wallKey,
		requiredTier,
		workspaceId,
	}: {
		currentTier: string;
		onClose: () => void;
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
			>
				<button
					type="button"
					data-testid="upgrade-modal-close"
					onClick={onClose}
				/>
			</div>
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
	ctx.me = null;
	ctx.workspaces = [];
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

const managesFreeOrg = (isStaff = false, tier = "free") => {
	ctx.me = {
		is_staff: isStaff,
		orgs: [{ id: "org-free", name: "Mine", role: "owner" }],
	};
	ctx.workspaces = [
		{
			bills_separately: true,
			id: "ws-client",
			org_id: "org-free",
			tier: "free",
		},
		{ id: "ws-free", is_default: true, org_id: "org-free", tier },
	];
};

it("opens the org wall on open when the user already manages a free org, without the name step", async () => {
	managesFreeOrg();
	renderModal();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("org_cap");
	expect(screen.queryByTestId("create-organisation-name-input")).toBeNull();
	expect(fetchMock).not.toHaveBeenCalled();
});

it("targets the managed free org's id and workspace", async () => {
	activeWorkspace.current = { id: "ws-paid", role: "owner", tier: "guardian" };
	managesFreeOrg();
	renderModal();
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.org).toBe("org-free");
	expect(modal.dataset.workspace).toBe("ws-free");
});

it("shows the name step when the managed org is paid", async () => {
	managesFreeOrg(false, "guardian");
	renderModal();
	expect(
		await screen.findByTestId("create-organisation-name-input"),
	).toBeTruthy();
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("shows the name step when the user is only a member of the free org", async () => {
	managesFreeOrg();
	ctx.me = {
		is_staff: false,
		orgs: [{ id: "org-free", name: "Mine", role: "member" }],
	};
	renderModal();
	expect(
		await screen.findByTestId("create-organisation-name-input"),
	).toBeTruthy();
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("shows the name step for staff", async () => {
	managesFreeOrg(true);
	renderModal();
	expect(
		await screen.findByTestId("create-organisation-name-input"),
	).toBeTruthy();
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("closing the up-front wall closes the modal", async () => {
	managesFreeOrg();
	renderModal();
	await screen.findByTestId("upgrade-modal");
	fireEvent.click(screen.getByTestId("upgrade-modal-close"));
	expect(onClose).toHaveBeenCalled();
});

it("keeps the invite step once the newly created free org shows up", async () => {
	fetchMock.mockResolvedValue(
		answer(200, { org_id: "org-new", workspace_id: "ws-new" }),
	);
	const view = renderModal();
	await submit();
	await screen.findByText("Send invites");
	ctx.me = {
		is_staff: false,
		orgs: [{ id: "org-new", name: "Acme", role: "owner" }],
	};
	ctx.workspaces = [
		{ id: "ws-new", is_default: true, org_id: "org-new", tier: "free" },
	];
	view.rerender(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<CreateOrganisationModal opened onClose={onClose} />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	expect(screen.getByText("Send invites")).toBeTruthy();
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
