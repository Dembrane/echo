// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { CreateProjectButton } from "./CreateProjectButton";

const cap = vi.hoisted(() => ({ arg: undefined as unknown, at: false }));

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: "owner", tier: "free" },
	}),
}));
vi.mock("@/hooks/useProjectCap", () => ({
	useProjectCap: (w: unknown) => {
		cap.arg = w;
		return cap.at;
	},
}));
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		opened,
		wallKey,
		workspaceId,
	}: {
		opened: boolean;
		wallKey: string;
		workspaceId: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-workspace={workspaceId}
			/>
		) : null,
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
});

afterEach(() => {
	cleanup();
	cap.at = false;
});

const renderButton = (onCreate = vi.fn()) => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<CreateProjectButton onCreate={onCreate} size="sm" />
			</MantineProvider>
		</I18nProvider>,
	);
	return onCreate;
};

it("creates as usual below the cap, with no unavailable mark", () => {
	const onCreate = renderButton();
	fireEvent.click(screen.getByTestId("project-home-create-button"));
	expect(onCreate).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("unavailable-info")).toBeNull();
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("at the cap shows the unavailable mark and opens the project wall in place", () => {
	cap.at = true;
	const onCreate = renderButton();
	expect(screen.getByTestId("unavailable-info")).toBeTruthy();
	fireEvent.click(screen.getByTestId("project-home-create-button"));
	expect(onCreate).not.toHaveBeenCalled();
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("project_cap");
	expect(modal.dataset.workspace).toBe("w1");
});
