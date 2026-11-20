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
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { ProjectLegalBasisSection } from "./ProjectLegalBasisSection";

const { card } = vi.hoisted(() => ({
	card: { props: null as null | Record<string, unknown> },
}));

vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: { email: "ada@example.com" } }),
}));
vi.mock("@/components/common/Toaster", () => ({ toast: { success: vi.fn() } }));
// The card is LegalBasisCard's own concern; here it only has to expose its callbacks.
vi.mock("@/components/settings/LegalBasisCard", async (original) => ({
	...(await original<object>()),
	LegalBasisCard: (props: {
		onSave: (p: unknown) => void;
		onClear?: () => void;
		canEdit: boolean;
	}) => {
		card.props = props;
		return (
			<div data-testid="legal-card">
				<button
					type="button"
					onClick={() =>
						props.onSave({
							legal_basis: "consent",
							privacy_policy_url: "https://p",
						})
					}
				>
					save card
				</button>
				{props.onClear && (
					<button type="button" onClick={props.onClear}>
						clear card
					</button>
				)}
			</div>
		);
	},
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
});

const inheritedConsent = {
	legal_basis: "consent",
	privacy_policy_url: null,
	source: "workspace",
};
const legal = (role: string, override: null | { legal_basis: string }) => ({
	_legal: {
		effective: override
			? { ...override, privacy_policy_url: "https://p", source: "project" }
			: inheritedConsent,
		inherited: inheritedConsent,
		organiser_name: null,
	},
	_role: role,
	legal_basis: override?.legal_basis ?? null,
	privacy_policy_url: override ? "https://p" : null,
});

let current = legal("admin", null);
const patches: unknown[] = [];

beforeEach(() => {
	card.props = null;
	patches.length = 0;
	current = legal("admin", null);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "PATCH") {
				patches.push(JSON.parse(String(init.body)));
				return new Response(null, { status: 204 });
			}
			return new Response(JSON.stringify(current), {
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

const show = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter>
						<ProjectLegalBasisSection projectId="p1" />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const consentWarning = /Consent-based processing is active without a privacy/;

describe("ProjectLegalBasisSection", () => {
	it("warns about consent without a policy, and opens and cancels an override", async () => {
		show();
		expect(await screen.findByText(consentWarning)).toBeTruthy();
		expect(screen.queryByTestId("legal-card")).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Override for this project" }),
		);
		expect(screen.getByTestId("legal-card")).toBeTruthy();
		// The card carries its own warning; the two never stack.
		expect(screen.queryByText(consentWarning)).toBeNull();
		expect(card.props?.onClear).toBeUndefined();

		fireEvent.click(screen.getByText("Cancel override"));
		expect(screen.queryByTestId("legal-card")).toBeNull();
		expect(screen.getByText(consentWarning)).toBeTruthy();
	});

	it("saves an override and closes the form", async () => {
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Override for this project" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "save card" }));
		await waitFor(() =>
			expect(patches).toEqual([
				{ legal_basis: "consent", privacy_policy_url: "https://p" },
			]),
		);
		await waitFor(() => expect(screen.queryByTestId("legal-card")).toBeNull());
	});

	it("removes a project override after confirming", async () => {
		current = legal("owner", { legal_basis: "client-managed" });
		show();
		fireEvent.click(await screen.findByRole("button", { name: "clear card" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove override" }),
		);
		await waitFor(() =>
			expect(patches).toEqual([
				{ legal_basis: null, privacy_policy_url: null },
			]),
		);
	});

	it("shows a member the setting without a way to change it", async () => {
		current = legal("member", { legal_basis: "client-managed" });
		show();
		await screen.findByTestId("legal-card");
		expect(card.props?.canEdit).toBe(false);
		expect(card.props?.onClear).toBeUndefined();
		expect(screen.queryByText("Workspace settings")).toBeNull();
	});
});
