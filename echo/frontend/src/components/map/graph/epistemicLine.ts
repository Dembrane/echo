import { t } from "@lingui/core/macro";
import type { FactCheckVerdict, MapGraphNode } from "../types";

type VerdictKey = FactCheckVerdict | "unverified";

// Order controls rendering sequence in the line.
const DISPLAY_ORDER: VerdictKey[] = [
	"true",
	"contested",
	"false",
	"unverified",
];

const verdictKey = (
	node: Pick<MapGraphNode, "metadata">,
): VerdictKey | null => {
	if ((node.metadata.kind ?? "argument") !== "claim") return null;
	const fc = node.metadata.factCheck;
	if (!fc || fc.status !== "done") return "unverified";
	return fc.verdict;
};

const countLabel = (key: VerdictKey, count: number): string => {
	switch (key) {
		case "true":
			return t`${count} confirmed`;
		case "false":
			return t`${count} refuted`;
		case "contested":
			return t`${count} contested`;
		case "unknown":
		case "unverified":
			return t`${count} unverified`;
	}
};

/**
 * Builds the deterministic "1 confirmed · 2 contested · 3 unverified" line
 * for a cluster of nodes. Returns null when the cluster contains no claims.
 */
export const buildEpistemicLine = (
	members: ReadonlyArray<Pick<MapGraphNode, "metadata">>,
): string | null => {
	const counts: Record<VerdictKey, number> = {
		contested: 0,
		false: 0,
		true: 0,
		unknown: 0,
		unverified: 0,
	};

	let claimCount = 0;
	for (const node of members) {
		const key = verdictKey(node);
		if (key === null) continue;
		claimCount += 1;
		counts[key] += 1;
	}

	if (claimCount === 0) return null;

	const parts: string[] = [];
	for (const key of DISPLAY_ORDER) {
		const n = counts[key];
		if (n > 0) parts.push(countLabel(key, n));
	}

	// "unknown" (done with verdict unknown) shares the "unverified" label and
	// is only emitted when no idle/processing/error claims were counted.
	if (counts.unknown > 0 && counts.unverified === 0) {
		parts.push(countLabel("unknown", counts.unknown));
	}

	return parts.join(" · ");
};
