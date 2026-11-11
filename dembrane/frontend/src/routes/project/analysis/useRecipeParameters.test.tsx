// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalysisRecipe, AnalysisRun } from "@/components/analysis/hooks";
import { recipeDefaults, useRecipeParameters } from "./useRecipeParameters";

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

describe("recipe defaults", () => {
	const tensions = {
		id: "tensions",
		parametersSchema: {
			properties: {
				input_set: { enum: ["arguments", "deduplicated_arguments"] },
			},
			required: ["input_set"],
		},
	} as unknown as AnalysisRecipe;
	const dedup = (status: string) =>
		({ recipeId: "deduplicated_arguments", status }) as AnalysisRun;

	it("preselects the first input set when no deduplicated output is ready", () => {
		expect(recipeDefaults(tensions, [dedup("running")])).toEqual({
			input_set: "arguments",
		});
	});

	it("prefers the deduplicated set once it is ready", () => {
		expect(recipeDefaults(tensions, [dedup("ready")])).toEqual({
			input_set: "deduplicated_arguments",
		});
	});
});
