// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CreateProjectRoute } from "./CreateProjectRoute";

const role = vi.hoisted(() => ({ current: "owner" }));
const createMutate = vi.hoisted(() => vi.fn());

vi.mock("@posthog/react", () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", name: "W", role: role.current, tier: "free" },
		workspaceId: "w1",
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
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
