// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalysisRun } from "@/components/analysis/hooks";
import { useRecipeParameters } from "./useRecipeParameters";

// A refetch of the runs query hands back equal-but-new objects, which is what
// used to wipe the host's typing while a run was in progress.
const runFor = (id: string, parameters: Record<string, unknown>) =>
	({
		id,
		parameters,
		recipeId: "popcorn",
		scopeKey: "project",
		status: "running",
	}) as AnalysisRun;

type Props = {
	latestRun?: AnalysisRun;
	recipeId: string;
	scopeKey: string;
};

const show = (initialProps: Props) =>
	renderHook(
		({ latestRun, recipeId, scopeKey }: Props) =>
			useRecipeParameters({
				// A new object every render, exactly as the recipe card builds it.
				defaults: { max_phrases: 5 },
				latestRun,
				recipeId,
				scopeKey,
			}),
		{ initialProps },
	);

describe("recipe parameters a host is typing", () => {
	it("survives a runs refetch that only changes object identity", () => {
		const { rerender, result } = show({
			latestRun: runFor("run-1", { max_phrases: 5 }),
			recipeId: "popcorn",
			scopeKey: "project",
		});

		act(() => result.current.setParameter("max_phrases", 12));
		rerender({
			latestRun: runFor("run-1", { max_phrases: 5 }),
			recipeId: "popcorn",
			scopeKey: "project",
		});

		expect(result.current.parameters.max_phrases).toBe(12);
	});

	it("adopts the server values when the recipe or the scope changes", () => {
		const { rerender, result } = show({
			latestRun: runFor("run-1", { max_phrases: 5 }),
			recipeId: "popcorn",
			scopeKey: "project",
		});

		act(() => result.current.setParameter("max_phrases", 12));
		rerender({
			latestRun: runFor("run-2", { max_phrases: 7 }),
			recipeId: "popcorn",
			scopeKey: "conversation:abc",
		});
		expect(result.current.parameters.max_phrases).toBe(7);

		rerender({
			latestRun: undefined,
			recipeId: "tensions",
			scopeKey: "project",
		});
		expect(result.current.parameters.max_phrases).toBe(5);
	});

	it("takes the run it just requested once that run arrives", () => {
		const { rerender, result } = show({
			latestRun: runFor("run-1", { max_phrases: 5 }),
			recipeId: "popcorn",
			scopeKey: "project",
		});

		act(() => result.current.setParameter("max_phrases", 12));
		act(() => result.current.markRequested());
		rerender({
			latestRun: runFor("run-2", { max_phrases: 12 }),
			recipeId: "popcorn",
			scopeKey: "project",
		});

		expect(result.current.parameters.max_phrases).toBe(12);
	});
});
