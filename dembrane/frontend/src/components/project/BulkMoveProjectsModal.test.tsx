// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { BulkMoveProjectsModal } from "./BulkMoveProjectsModal";

// Moving selected projects: only to workspaces the user runs, in the same
// billing context as where they are now.
const mutate = vi.hoisted(() => vi.fn());
vi.mock("./hooks", () => ({
	useBulkMoveProjectsMutation: () => ({ isPending: false, mutate }),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: () => null,
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "ws-a", role: "admin" },
		workspaces: [
			{
				bills_separately: false,
				id: "ws-a",
				name: "Here",
				org_id: "o1",
				role: "admin",
			},
			{
				bills_separately: false,
				id: "ws-b",
				name: "Sibling",
				org_id: "o1",
				role: "owner",
			},
			{
				bills_separately: false,
				id: "ws-c",
				name: "Read only",
				org_id: "o1",
				role: "member",
			},
			{
				bills_separately: true,
				id: "ws-d",
				name: "Own billing",
				org_id: "o1",
				role: "admin",
			},
			{
				bills_separately: false,
				id: "ws-e",
				name: "Other org",
				org_id: "o2",
				role: "admin",
			},
		],
	}),
}));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
	cleanup();
	mutate.mockReset();
});

const tree = (opened: boolean, onMoved = () => {}, onClose = () => {}) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider env="test">
			<BulkMoveProjectsModal
				opened={opened}
				onClose={onClose}
				projectIds={["p1", "p2"]}
				sourceWorkspaceId="ws-a"
				onMoved={onMoved}
			/>
		</MantineProvider>
	</I18nProvider>
);
const choose = (name: string) => {
	fireEvent.click(screen.getByTestId("bulk-move-projects-select"));
	fireEvent.click(screen.getByRole("option", { name }));
};
const confirm = () => screen.getByTestId("bulk-move-projects-confirm");

it("offers only workspaces the user runs, in the same billing context", () => {
	render(tree(true));
	fireEvent.click(screen.getByTestId("bulk-move-projects-select"));
	expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
		"Sibling",
	]);
});

it("moves the projects to the chosen workspace", () => {
	mutate.mockImplementation((_vars, { onSuccess }) => onSuccess());
	const onMoved = vi.fn();
	const onClose = vi.fn();
	render(tree(true, onMoved, onClose));
	expect(confirm()).toHaveProperty("disabled", true);
	choose("Sibling");
	fireEvent.click(confirm());
	expect(mutate.mock.calls[0][0]).toEqual({
		projectIds: ["p1", "p2"],
		targetWorkspaceId: "ws-b",
	});
	expect(onMoved).toHaveBeenCalled();
	expect(onClose).toHaveBeenCalled();
});

it("forgets the choice once closed", () => {
	const view = render(tree(true));
	choose("Sibling");
	expect(confirm()).toHaveProperty("disabled", false);
	view.rerender(tree(false));
	view.rerender(tree(true));
	expect(confirm()).toHaveProperty("disabled", true);
});
