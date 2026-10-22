// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProjectCap } from "./useProjectCap";

const state = vi.hoisted(() => ({
	allowance: undefined as unknown,
	calls: [] as Array<string | null | undefined>,
	me: { is_staff: false } as unknown,
}));

vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: state.me }) }));
vi.mock("@/hooks/useFreeAllowance", () => ({
	useFreeAllowance: (id: string | null | undefined) => {
		state.calls.push(id);
		return { data: id ? state.allowance : undefined };
	},
}));

const free = { id: "w1", role: "owner", tier: "free" };
const meter = (used: number, limit: number) => ({
	free: true,
	projects: { limit, used },
});

beforeEach(() => {
	state.allowance = undefined;
	state.calls = [];
	state.me = { is_staff: false };
});

it("is at the cap when a free account has used its projects", () => {
	state.allowance = meter(1, 1);
	expect(renderHook(() => useProjectCap(free)).result.current).toBe(true);
});

it("is not at the cap with room left", () => {
	state.allowance = meter(0, 1);
	expect(renderHook(() => useProjectCap(free)).result.current).toBe(false);
});

it("never reads the allowance on a paid workspace", () => {
	state.allowance = meter(5, 1);
	const { result } = renderHook(() =>
		useProjectCap({ ...free, tier: "guardian" }),
	);
	expect(result.current).toBe(false);
	expect(state.calls.every((id) => !id)).toBe(true);
});

it("never blocks staff", () => {
	state.me = { is_staff: true };
	state.allowance = meter(1, 1);
	expect(renderHook(() => useProjectCap(free)).result.current).toBe(false);
	expect(state.calls.every((id) => !id)).toBe(true);
});

it("never blocks outsiders, who cannot create projects anyway", () => {
	state.allowance = meter(1, 1);
	const { result } = renderHook(() =>
		useProjectCap({ ...free, role: "external" }),
	);
	expect(result.current).toBe(false);
});
