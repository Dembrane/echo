// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAllowanceApplies } from "./useAllowanceApplies";

const state = vi.hoisted(() => ({
	args: null as unknown,
	result: { data: undefined, isSuccess: false } as {
		data?: { is_sample?: boolean | null };
		isSuccess: boolean;
	},
}));

vi.mock("@/components/project/hooks", () => ({
	useProjectById: (args: unknown) => {
		state.args = args;
		return state.result;
	},
}));

beforeEach(() => {
	state.result = { data: undefined, isSuccess: false };
});

it("asks for is_sample only", () => {
	renderHook(() => useAllowanceApplies("p1"));
	expect(state.args).toEqual({
		projectId: "p1",
		query: { fields: ["id", "is_sample"] },
	});
});

it("does not apply until the project loads", () => {
	const { result } = renderHook(() => useAllowanceApplies("p1"));
	expect(result.current).toEqual({ applies: false, isSample: false });
});

it("applies to a loaded project that is not a sample", () => {
	state.result = { data: { is_sample: null }, isSuccess: true };
	const { result } = renderHook(() => useAllowanceApplies("p1"));
	expect(result.current).toEqual({ applies: true, isSample: false });
});

it("exempts a sample project", () => {
	state.result = { data: { is_sample: true }, isSuccess: true };
	const { result } = renderHook(() => useAllowanceApplies(undefined));
	expect(result.current).toEqual({ applies: false, isSample: true });
	expect((state.args as { projectId: string }).projectId).toBe("");
});
