// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
	act,
	cleanup,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AiBudgetWall, useAiBudgetWall } from "./AiBudgetWall";

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

const aiRefusal = {
	response: {
		data: {
			code: "billing.tier_limit",
			detail: {
				error: "FREE_TIER_LIMIT",
				limit: "ai_budget",
				percent: 100,
				resets_at: "2026-12-01T00:00:00Z",
			},
			params: { limit: "ai_budget" },
		},
		status: 402,
	},
};

it("opens from an ai_budget refusal with its reset time, and ignores anything else", () => {
	const { result } = renderHook(() => useAiBudgetWall());
	let opened = true;
	act(() => {
		opened = result.current.openFor(new Error("boom"));
	});
	expect(opened).toBe(false);
	expect(result.current.props.opened).toBe(false);

	act(() => {
		opened = result.current.openFor(aiRefusal);
	});
	expect(opened).toBe(true);
	expect(result.current.props).toMatchObject({
		opened: true,
		resetsAt: "2026-12-01T00:00:00Z",
		usedUp: true,
	});

	// Closing keeps the date, so the closing popup does not flicker.
	act(() => result.current.close());
	expect(result.current.props).toMatchObject({
		opened: false,
		resetsAt: "2026-12-01T00:00:00Z",
	});
});

it("opens neutrally when asked to, with no refusal behind it", () => {
	const { result } = renderHook(() => useAiBudgetWall());
	act(() => result.current.open(null, false));
	expect(result.current.props).toMatchObject({
		opened: true,
		resetsAt: null,
		usedUp: false,
	});
});
