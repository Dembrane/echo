import { useState } from "react";
import type { AnalysisRun } from "@/components/analysis/hooks";

type ParameterState = {
	dirty: boolean;
	runToken: string;
	scopeToken: string;
	values: Record<string, unknown>;
};

const serverValues = (
	defaults: Record<string, unknown>,
	latestRun?: AnalysisRun,
): Record<string, unknown> => ({
	...defaults,
	...(latestRun?.parameters ?? {}),
});

export type RecipeParameters = {
	parameters: Record<string, unknown>;
	setParameter: (name: string, value: unknown) => void;
	/** The run request landed: what the host typed is now the server's copy. */
	markRequested: () => void;
};

/**
 * Parameters a host types before requesting a run.
 *
 * The runs query is invalidated by every analysis event, so `latestRun` is a
 * fresh object several times a minute while anything is running. Adopting its
 * parameters whenever that object changes wiped what the host was typing, so
 * server values are adopted only when the thing being edited changes — the
 * recipe, the scope, or the run itself — and never over unsent edits.
 */
export function useRecipeParameters({
	defaults,
	latestRun,
	recipeId,
	scopeKey,
}: {
	defaults: Record<string, unknown>;
	latestRun?: AnalysisRun;
	recipeId: string;
	scopeKey: string;
}): RecipeParameters {
	const scopeToken = `${recipeId}|${scopeKey}`;
	const runToken = latestRun?.id ?? "";
	const [state, setState] = useState<ParameterState>(() => ({
		dirty: false,
		runToken,
		scopeToken,
		values: serverValues(defaults, latestRun),
	}));

	// Switching recipe or scope drops the edits with the thing they belonged
	// to; a new run only wins when nothing is waiting to be sent.
	const adopt =
		state.scopeToken !== scopeToken ||
		(state.runToken !== runToken && !state.dirty);
	if (adopt) {
		setState({
			dirty: false,
			runToken,
			scopeToken,
			values: serverValues(defaults, latestRun),
		});
	}

	return {
		markRequested: () =>
			setState((current) =>
				current.dirty ? { ...current, dirty: false } : current,
			),
		parameters: state.values,
		setParameter: (name, value) =>
			setState((current) => ({
				...current,
				dirty: true,
				values: { ...current.values, [name]: value },
			})),
	};
}
