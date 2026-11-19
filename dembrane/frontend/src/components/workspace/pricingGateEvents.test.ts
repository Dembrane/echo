// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGateViewed, usePricingGateEmitter } from "./pricingGateEvents";

// The gate's events carry the account side, and the emitters stay the same
// across renders so the configurator's effects do not run again.
const capture = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture } }));
vi.mock("@lingui/react", () => {
	const lingui = { i18n: { locale: "nl-NL" } };
	return { useLingui: () => lingui };
});
vi.mock("@/hooks/useWorkspace", () => {
	const value = { workspace: { id: "w1", org_id: "o1", tier: "pro" } };
	return { useWorkspace: () => value };
});
vi.mock("@/components/auth/hooks", () => {
	const value = { data: { email: "Someone@Dembrane.com" } };
	return { useCurrentUser: () => value };
});
afterEach(() => capture.mockClear());

const base = {
	is_internal: true,
	locale: "nl-NL",
	org_id: "o1",
	tier: "pro",
	workspace_id: "w1",
};

it("keeps both emitters across renders", () => {
	const { result, rerender } = renderHook(() => ({
		emit: usePricingGateEmitter(undefined, "chat"),
		viewed: useGateViewed(),
	}));
	const first = result.current;
	rerender();
	expect(result.current.emit).toBe(first.emit);
	expect(result.current.viewed).toBe(first.viewed);
});

it("adds the account side and the refused action to each event", () => {
	const { result } = renderHook(() => usePricingGateEmitter("w2", "chat"));
	result.current("pricing_config_answered", { step: 2 });
	expect(capture).toHaveBeenCalledWith("pricing_config_answered", {
		...base,
		ai_action: "chat",
		step: 2,
		workspace_id: "w2",
	});
});

it("sends the gate-viewed event with the surface", () => {
	const { result } = renderHook(() => useGateViewed());
	result.current({
		canRequestUpgrade: false,
		requiredTier: "pro",
		surface: "popover",
		wallKey: "custom_logo",
	});
	expect(capture).toHaveBeenCalledWith("pricing_config_gate_viewed", {
		...base,
		can_request_upgrade: false,
		mount: "app",
		required_tier: "pro",
		surface: "popover",
		wall_key: "custom_logo",
	});
});
