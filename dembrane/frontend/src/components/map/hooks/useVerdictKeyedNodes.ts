import { useState } from "react";
import { factCheckSignature, withFactChecks } from "../data/adapter";
import type { MapGraphNode } from "../types";
import type { FactCheckStates } from "./index";

/**
 * The nodes with their fact-check state in metadata, for the renderers.
 * Renderers restyle from node metadata, so the array is rebuilt only when
 * the nodes change or a displayed verdict does, never for other fact-check
 * fields (a check in progress, a reworded justification).
 *
 * The key is kept in state and compared during render, the pattern React
 * documents for "storing information from previous renders"; a useMemo with
 * a hand-picked dependency list can't say this to React Compiler.
 */
export function useVerdictKeyedNodes(
	placedNodes: MapGraphNode[],
	factCheckStates: FactCheckStates | undefined,
): MapGraphNode[] {
	const signature = factCheckSignature(placedNodes, factCheckStates);
	const [kept, setKept] = useState(() => ({
		nodes: withFactChecks(placedNodes, factCheckStates),
		placedNodes,
		signature,
	}));
	if (kept.placedNodes !== placedNodes || kept.signature !== signature) {
		const next = {
			nodes: withFactChecks(placedNodes, factCheckStates),
			placedNodes,
			signature,
		};
		setKept(next);
		return next.nodes;
	}
	return kept.nodes;
}
