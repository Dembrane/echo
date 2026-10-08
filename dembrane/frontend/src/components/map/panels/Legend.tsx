import { Plural, Trans } from "@lingui/react/macro";
import { memo } from "react";
import {
	conversationColor,
	conversationSlotLabel,
	type LegendEntry,
	legendEntries,
	resolveMapColor,
	slotKey,
} from "../attributes";
import { getNodeStyleFromInputs } from "../graph/nodeStyle";
import type { ColorBy } from "../types";
import { mapVars } from "./shared";

/** How many conversations the legend names before it counts the rest. */
const NAMED_CONVERSATIONS = 8;

/** Colour key of the active attribute, from its definition; nothing in None. */
export const Legend = memo(function Legend({
	colorBy,
	darkMode,
	conversations = 0,
	names,
	tags = [],
}: {
	colorBy: ColorBy;
	darkMode: boolean;
	/** Conversations on this map; the conversation legend is built from them. */
	conversations?: number;
	/**
	 * What to call the conversation in a slot. The host map has every name;
	 * the room's has them where the presentation says the room may read them,
	 * and numbers the rest.
	 */
	names?: ReadonlyMap<number, string>;
	/** The map's tags in slot order; the tag legend is built from them. */
	tags?: ReadonlyArray<{ name: string; slot: number }>;
}) {
	const rows: LegendEntry[] =
		colorBy === "tag"
			? [
					...tags.map((tag) => ({
						color: conversationColor(tag.slot),
						key: slotKey(tag.slot),
						label: tag.name,
					})),
					...legendEntries("tag"),
				]
			: colorBy === "conversation"
				? Array.from(
						{ length: Math.min(conversations, NAMED_CONVERSATIONS) },
						(_value, slot) => ({
							color: conversationColor(slot),
							key: slotKey(slot),
							label: names?.get(slot) || conversationSlotLabel(slot),
						}),
					)
				: legendEntries(colorBy);
	if (rows.length === 0) return null;
	// The swatches carry the same shadow, hairline and theme-resolved fills
	// as the nodes they explain.
	const { filter, stroke, strokeWidth } = getNodeStyleFromInputs(
		{},
		{ colorBy, darkMode },
	);

	return (
		<div
			className="absolute bottom-4 right-4 z-10 space-y-1 border-y px-3 py-2 text-xs"
			style={{
				backgroundColor: mapVars.raised,
				borderColor: mapVars.border,
				boxShadow: "var(--app-float)",
				color: mapVars.text,
			}}
		>
			<p className="mb-1 text-xs">
				<Trans>Legend</Trans>
			</p>
			{rows.map((row) => (
				<div key={row.key} className="flex items-center gap-2">
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
						<circle
							cx="8"
							cy="8"
							r="5"
							fill={resolveMapColor(row.color, darkMode)}
							strokeWidth={strokeWidth}
							style={{ filter, stroke }}
						/>
					</svg>
					<span>{row.label}</span>
				</div>
			))}
			{colorBy === "conversation" && conversations > NAMED_CONVERSATIONS && (
				<p>
					<Plural
						value={conversations - NAMED_CONVERSATIONS}
						one="and # more conversation"
						other="and # more conversations"
					/>
				</p>
			)}
		</div>
	);
});
