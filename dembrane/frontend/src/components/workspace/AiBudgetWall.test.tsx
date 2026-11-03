// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AiBudgetWall } from "./AiBudgetWall";

const modalProps = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: (props: { opened: boolean; wallKey: string }) => {
		modalProps.current = props;
		return props.opened ? (
			<div data-testid="upgrade-modal" data-wall={props.wallKey} />
		) : null;
	},
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
});

const renderWall = (opened: boolean, usedUp?: boolean) =>
	render(
		<I18nProvider i18n={i18n}>
			<AiBudgetWall
				opened={opened}
				usedUp={usedUp}
				onClose={() => {}}
				action="report"
				resetsAt="2026-12-01T00:00:00Z"
				workspaceId="workspace-1"
				projectId="project-1"
			/>
		</I18nProvider>,
	);

it("opens the one upgrade modal on the ai_budget wall with the action and reset date", () => {
	renderWall(true);
	expect(screen.getByTestId("upgrade-modal").getAttribute("data-wall")).toBe(
		"ai_budget",
	);
	expect(modalProps.current).toMatchObject({
		aiAction: "report",
		currentTier: "free",
		entry: "modal_direct",
		projectId: "project-1",
		resetsAt: "2026-12-01T00:00:00Z",
		workspaceId: "workspace-1",
	});
	expect(modalProps.current.requiredTier).not.toBeNull();
});

it("says the budget is used up by default", () => {
	renderWall(true);
	expect(modalProps.current.aiUsedUp).toBe(true);
});

it("opens without the used-up claim when the budget is not used up yet", () => {
	renderWall(true, false);
	expect(modalProps.current).toMatchObject({
		aiUsedUp: false,
		wallKey: "ai_budget",
	});
	// Nothing was refused, so no action is named.
	expect(modalProps.current.aiAction).toBeUndefined();
});

it("renders nothing while closed", () => {
	renderWall(false);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
