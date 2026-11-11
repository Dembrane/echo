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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CreateProjectRoute } from "./CreateProjectRoute";

const role = vi.hoisted(() => ({ current: "owner" }));
const createMutate = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const tier = vi.hoisted(() => ({ current: "free" }));
const me = vi.hoisted(() => ({ current: { is_staff: false } as unknown }));
const allowance = vi.hoisted(() => ({
	calls: [] as Array<string | null | undefined>,
	data: undefined as unknown,
}));

vi.mock("@posthog/react", () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", name: "W", role: role.current, tier: tier.current },
		workspaceId: "w1",
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: me.current }) }));
vi.mock("@/hooks/useFreeAllowance", () => ({
	useFreeAllowance: (id: string | null | undefined) => {
		allowance.calls.push(id);
		return { data: id ? allowance.data : undefined };
	},
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		opened,
		onClose,
		wallKey,
	}: {
		opened: boolean;
		onClose: () => void;
		wallKey: string;
	}) =>
		opened ? (
			<div data-testid="upgrade-modal" data-wall={wallKey}>
				<button
					type="button"
					data-testid="upgrade-modal-close"
					onClick={onClose}
				/>
			</div>
		) : null,
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
vi.mock("@/hooks/useWorkspaceProjects", () => ({
	useCreateWorkspaceProject: () => ({ mutateAsync: createMutate }),
}));
vi.mock("@/components/project/hooks", () => ({
	useUpdateProjectByIdMutation: () => ({ mutateAsync: vi.fn() }),
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	role.current = "owner";
	tier.current = "free";
	me.current = { is_staff: false };
	allowance.calls = [];
	allowance.data = undefined;
	navigate.mockReset();
});

const projectsMeter = (used: number, limit: number) => ({
	free: true,
	projects: { limit, used },
});

beforeAll(() => {
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

const tree = (client = new QueryClient()) => (
	<QueryClientProvider client={client}>
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter>
					<CreateProjectRoute />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>
	</QueryClientProvider>
);

const renderCreate = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter>
						<CreateProjectRoute />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("CreateProjectRoute role gating", () => {
	it.each([
		// project:create: members and admins, not outsiders
		["owner", true],
		["member", true],
		["external", false],
		["observer", false],
	])("%s: wizard shown %s", (r, canCreate) => {
		role.current = r;
		renderCreate();
		expect(!!screen.queryByLabelText("Project name")).toBe(canCreate);
		expect(!!screen.queryByTestId("create-project-not-allowed")).toBe(
			!canCreate,
		);
	});
});

describe("CreateProjectRoute free project cap", () => {
	it("opens the project wall on arrival when the free project cap is reached", () => {
		allowance.data = projectsMeter(1, 1);
		renderCreate();
		expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe(
			"project_cap",
		);
	});

	it("shows the wizard without a wall when under the cap", () => {
		allowance.data = projectsMeter(0, 1);
		renderCreate();
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
		expect(screen.getByLabelText("Project name")).toBeTruthy();
	});

	it("does not fetch the allowance on a paid workspace", () => {
		tier.current = "guardian";
		allowance.data = projectsMeter(5, 1);
		renderCreate();
		expect(allowance.calls.every((id) => !id)).toBe(true);
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("never shows the up-front wall to staff", () => {
		me.current = { is_staff: true };
		allowance.data = projectsMeter(1, 1);
		renderCreate();
		expect(allowance.calls.every((id) => !id)).toBe(true);
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("closing the arrival wall returns to projects", () => {
		allowance.data = projectsMeter(1, 1);
		renderCreate();
		fireEvent.click(screen.getByTestId("upgrade-modal-close"));
		expect(navigate).toHaveBeenCalledWith("/w/w1/home");
	});

	it("does not open the wall when the cap is reached after the wizard has started", () => {
		const client = new QueryClient();
		const view = render(tree(client));
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "Town hall" },
		});
		allowance.data = projectsMeter(1, 1);
		view.rerender(tree(client));
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});

	it("does not open the wall after creating the last allowed project", async () => {
		allowance.data = projectsMeter(0, 1);
		createMutate.mockResolvedValue({ id: "p-new" });
		const client = new QueryClient();
		const view = render(tree(client));
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "Town hall" },
		});
		for (let i = 0; i < 3; i++)
			fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		fireEvent.click(screen.getByRole("button", { name: "Create project" }));
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		// The create refreshes the allowance, which now reads at the cap.
		allowance.data = projectsMeter(1, 1);
		view.rerender(tree(client));
		expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	});
});
