// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	ProjectConversationsRoute,
	ProjectSettingsRoute,
	ProjectUploadRoute,
} from "./ProjectRoutes";

const role = vi.hoisted(() => ({ current: "owner" }));
const usageCalls = vi.hoisted(
	() => [] as { id: unknown; opts?: { enabled?: boolean } }[],
);
const panelProps = vi.hoisted(() => ({ showUpload: undefined as unknown }));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
		workspaceId: "w1",
		workspaces: [{ id: "w1", role: role.current }],
	}),
}));
vi.mock("@/hooks/useWorkspaceUsage", () => ({
	useWorkspaceUsage: (id: unknown, opts?: { enabled?: boolean }) => {
		usageCalls.push({ id, opts });
		return {
			usageGates: {
				over_cap_active: false,
				upgrade_cta_tier: null,
				uploads_locked: false,
			},
		};
	},
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({
		data: {
			context: "ctx",
			id: "p1",
			is_canvas_enabled: false,
			name: "Alpha project",
			updated_at: "2026-10-01T00:00:00Z",
			workspace_id: "w1",
		},
		isError: false,
		isLoading: false,
	}),
	useUpdateProjectByIdMutation: () => ({
		isPending: false,
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
	}),
	useVerificationTopicsQuery: () => ({ data: undefined }),
}));
vi.mock("@/components/goal/hooks", () => ({
	useProjectGoal: () => ({
		data: { current: null, revisions: [] },
		isError: false,
		isLoading: false,
	}),
	useSaveProjectGoalMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
}));
vi.mock("@/components/methodology/hooks", () => ({
	useMethodologies: () => ({
		data: [
			{
				id: "m1",
				is_seeded: true,
				latest_version: { id: "v1" },
				name: "dembrane",
			},
			{ id: "m2", is_seeded: false, latest_version: { id: "v2" }, name: "B" },
		],
		isError: false,
		isLoading: false,
	}),
	useSelectProjectMethodologyMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
}));
vi.mock("@/components/memory/ProjectMemorySection", () => ({
	ProjectMemorySection: () => <div data-testid="memory-section" />,
}));
vi.mock("@/components/project/ProjectMoveWorkspace", () => ({
	ProjectMoveWorkspace: () => null,
}));
vi.mock("@/components/project/ProjectDangerZone", () => ({
	ProjectDangerZone: () => null,
}));
vi.mock("@/components/dropzone/UploadConversationDropzone", () => ({
	UploadConversationDropzone: () => <div data-testid="upload-dropzone" />,
}));
vi.mock("@/components/conversation/ProjectConversationsPanel", () => ({
	ProjectConversationsPanel: (props: { showUpload?: boolean }) => {
		panelProps.showUpload = props.showUpload;
		return null;
	},
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	role.current = "owner";
	usageCalls.length = 0;
	panelProps.showUpload = undefined;
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
	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});

const renderAt = (element: ReactNode) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/w/w1/projects/p1/x"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/x"
								element={element}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("ProjectSettingsRoute role gating", () => {
	it("observer sees values but cannot edit or open the goal editor", () => {
		role.current = "observer";
		renderAt(<ProjectSettingsRoute />);
		const name = screen.getByTestId(
			"project-settings-name-input",
		) as HTMLInputElement;
		expect(name.value).toBe("Alpha project");
		expect(name.readOnly).toBe(true);
		const context = screen.getByDisplayValue("ctx") as HTMLTextAreaElement;
		expect(context.readOnly).toBe(true);
		expect(screen.queryByRole("button", { name: "Set goal" })).toBeNull();
		expect(
			(screen.getByTestId("project-methodology-select") as HTMLInputElement)
				.disabled,
		).toBe(true);
		expect(
			(
				screen.getByTestId(
					"project-experimental-canvas-toggle",
				) as HTMLInputElement
			).disabled,
		).toBe(true);
		// Listing project memory needs chat:use, which observers lack.
		expect(screen.queryByTestId("memory-section")).toBeNull();
	});

	it.each(["member", "admin", "owner"])("%s can edit", (r) => {
		role.current = r;
		renderAt(<ProjectSettingsRoute />);
		expect(
			(screen.getByTestId("project-settings-name-input") as HTMLInputElement)
				.readOnly,
		).toBe(false);
		expect(screen.getByRole("button", { name: "Set goal" })).toBeTruthy();
		expect(
			(screen.getByTestId("project-methodology-select") as HTMLInputElement)
				.disabled,
		).toBe(false);
		expect(
			(
				screen.getByTestId(
					"project-experimental-canvas-toggle",
				) as HTMLInputElement
			).disabled,
		).toBe(false);
		expect(screen.getByTestId("memory-section")).toBeTruthy();
	});
});

describe("Upload controls role gating", () => {
	it("observer gets no dropzone and no usage fetch on the upload page", () => {
		role.current = "observer";
		renderAt(<ProjectUploadRoute />);
		expect(screen.queryByTestId("upload-dropzone")).toBeNull();
		expect(usageCalls.every((c) => c.opts?.enabled === false)).toBe(true);
	});

	it("member gets the dropzone", () => {
		role.current = "member";
		renderAt(<ProjectUploadRoute />);
		expect(screen.getByTestId("upload-dropzone")).toBeTruthy();
	});

	it.each([
		["observer", false],
		["member", true],
		["owner", true],
	])("%s: conversations list upload %s", (r, expected) => {
		role.current = r;
		renderAt(<ProjectConversationsRoute />);
		expect(panelProps.showUpload).toBe(expected);
	});
});
