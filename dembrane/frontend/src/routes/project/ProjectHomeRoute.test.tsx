// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectHomeRoute } from "./ProjectHomeRoute";

const role = vi.hoisted(() => ({ current: "owner" }));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/hooks/useConversationMonitor", () => ({
	useConversationMonitor: () => ({ conversations: [] }),
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: { id: "p1", name: "Alpha" } }),
	useUpdateProjectByIdMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/components/report/hooks", () => ({
	useLatestProjectReport: () => ({ data: null }),
}));
vi.mock("@/components/conversation/hooks", () => ({
	useInfiniteConversationsByProjectId: () => ({ data: { pages: [] } }),
}));
vi.mock("@/components/conversation/LiveMonitorSection", () => ({
	LiveMonitorSection: () => null,
}));
vi.mock("@/components/project/PortalSettingsOverview", () => ({
	PortalSettingsOverview: () => null,
}));
vi.mock("@/components/project/ProjectHostGuideLink", () => ({
	ProjectHostGuideLink: () => null,
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

const renderHome = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/w/w1/projects/p1/home"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/home"
								element={<ProjectHomeRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("ProjectHomeRoute jump-to role gating", () => {
	it.each([
		// chat:use for chat, project:update for upload
		["owner", true, true],
		["member", true, true],
		["external", true, true],
		["observer", false, false],
	])("%s: start chat %s, upload %s", (r, canChat, canUpload) => {
		role.current = r;
		renderHome();
		expect(!!screen.queryByRole("button", { name: "Start a chat" })).toBe(
			canChat,
		);
		expect(!!screen.queryByRole("button", { name: "Upload audio" })).toBe(
			canUpload,
		);
		// Reading stays open to everyone.
		expect(screen.getByRole("button", { name: "Report" })).toBeTruthy();
	});
});
