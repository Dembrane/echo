// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSidebarView } from "../hooks/useSidebarView";
import { AppBreadcrumbs } from "./AppBreadcrumbs";

vi.mock("@/components/canvas/hooks", () => ({ useCanvas: () => ({}) }));
vi.mock("@/components/chat/hooks", () => ({ useChat: () => ({}) }));
vi.mock("@/components/conversation/hooks", () => ({
	useConversationById: () => ({}),
}));
vi.mock("@/components/project/hooks", () => ({ useProjectById: () => ({}) }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspaces: [] }),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
vi.mock("../hooks/useSidebarState", () => ({
	useSidebarState: () => ({ collapsed: false }),
}));

i18n.load("en-US", {});
i18n.activate("en-US");
afterEach(cleanup);

it.each(["/release-notes", "/en-US/release-notes?year=2025"])(
	"gives %s a global sidebar and a breadcrumb back to Home",
	(path) => {
		const [pathname, search] = path.split("?");
		expect(resolveSidebarView(pathname, search)).toMatchObject({
			params: {},
			scope: "user",
			view: "user-home",
		});
		render(
			<I18nProvider i18n={i18n}>
				<MemoryRouter initialEntries={[path]}>
					<AppBreadcrumbs />
				</MemoryRouter>
			</I18nProvider>,
		);
		expect(
			screen.getByRole("link", { name: "Home" }).getAttribute("href"),
		).toBe("/en-US/o");
		expect(screen.getByText("Release notes")).toBeTruthy();
	},
);
