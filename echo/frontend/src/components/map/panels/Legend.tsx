import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { memo } from "react";
import { baseColors } from "@/colors";
import { getNodeStyleFromInputs, MAP_NEUTRAL_GREY } from "../graph/nodeStyle";
import type { ColorBy } from "../types";
import { mapVars } from "./shared";

type Row = { color: string; label: string };

const rowsFor = (mode: ColorBy): Row[] => {
	if (mode === "valence") {
		return [
			{ color: baseColors.springGreen, label: t`Positive` },
			{ color: baseColors.salmon, label: t`Negative` },
			{ color: MAP_NEUTRAL_GREY, label: t`Neutral` },
		];
	}
	if (mode === "factCheck") {
		return [
			{ color: MAP_NEUTRAL_GREY, label: t`Argument (not fact-checked)` },
			{ color: baseColors.springGreen, label: t`Claim · likely true` },
			{ color: baseColors.salmon, label: t`Claim · likely false` },
			{ color: baseColors.limeYellow, label: t`Claim · contested` },
			{ color: baseColors.graphite, label: t`Claim · unverified` },
			{ color: baseColors.institutionBlue, label: t`Claim · checking…` },
		];
	}
	return [];
};

/** Colour key for the valence and fact-check modes; nothing in None. */
export const Legend = memo(function Legend({
	colorBy,
	darkMode,
}: {
	colorBy: ColorBy;
	darkMode: boolean;
}) {
	const rows = rowsFor(colorBy);
	if (rows.length === 0) return null;
	// The swatches carry the same shadow as the nodes they explain.
	const { filter } = getNodeStyleFromInputs({}, { colorBy, darkMode });

	return (
		<div
			className="absolute bottom-4 right-4 z-10 space-y-1 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-sm"
			style={{
				backgroundColor: mapVars.raised,
				borderColor: mapVars.border,
				color: mapVars.text,
			}}
		>
			<p className="mb-1 text-xs uppercase tracking-widest">
				<Trans>Legend</Trans>
			</p>
			{rows.map((row) => (
				<div key={row.label} className="flex items-center gap-2">
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r="5" fill={row.color} style={{ filter }} />
					</svg>
					<span>{row.label}</span>
				</div>
			))}
		</div>
	);
});
