import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader } from "@mantine/core";
import type { ReactNode } from "react";
import {
	attributeFor,
	attributeInputsOf,
	conversationColor,
	conversationSlotLabel,
	isFactCheckEligible,
	resolveAttribute,
} from "../attributes";
import type { Distillation } from "../hooks/useMapGroups";
import type { ColorBy, MapGraphNode } from "../types";

export type Share = {
	key: string;
	label: string;
	color: string;
	count: number;
};

/** How many shares a bar names under it before it counts the rest. */
const NAMED_SHARES = 4;

/** Shares of a colour mode over the nodes, largest first. */
export const attributeShares = (
	nodes: ReadonlyArray<MapGraphNode>,
	colorBy: Exclude<ColorBy, "conversation">,
): Share[] => {
	const shares = new Map<string, Share>();
	for (const node of nodes) {
		const value = resolveAttribute(
			attributeFor(colorBy),
			attributeInputsOf(node.metadata),
		);
		const share = shares.get(value.key);
		if (share) share.count += 1;
		else
			shares.set(value.key, {
				color: value.color,
				count: 1,
				key: value.key,
				label: value.label,
			});
	}
	return [...shares.values()].sort((a, b) => b.count - a.count);
};

/**
 * Which conversations the nodes come from, one count per contributing member,
 * so a merge counts every conversation it was made from.
 */
export const conversationShares = (
	nodes: ReadonlyArray<MapGraphNode>,
	names?: ReadonlyMap<number, string>,
): Share[] => {
	const counts = new Map<number, number>();
	for (const node of nodes) {
		for (const slot of node.metadata.conversationSlots ?? []) {
			counts.set(slot, (counts.get(slot) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.map(([slot, count]) => ({
			color: conversationColor(slot),
			count,
			key: `slot-${slot}`,
			label: names?.get(slot) || conversationSlotLabel(slot),
		}));
};

/** One strip of proportions in the map's own colours, named underneath. */
export const ShareBar = ({
	title,
	shares,
	testId,
}: {
	title: string;
	shares: ReadonlyArray<Share>;
	testId?: string;
}) => {
	if (shares.length === 0) return null;
	const named = shares.slice(0, NAMED_SHARES);
	const rest = shares.length - named.length;
	return (
		<div className="space-y-1" data-testid={testId}>
			<p className="text-xs">{title}</p>
			<div className="flex h-2 w-full gap-px" role="img" aria-label={title}>
				{shares.map((share) => (
					<span
						key={share.key}
						title={`${share.label}: ${share.count}`}
						style={{ backgroundColor: share.color, flexGrow: share.count }}
					/>
				))}
			</div>
			{/* One line, so the bars under it stay in view; the full line on hover. */}
			<p
				className="truncate text-xs"
				style={{ color: "var(--map-muted)" }}
				title={shares
					.map((share) => `${share.label} (${share.count})`)
					.join(" · ")}
			>
				{named.map((share) => `${share.label} (${share.count})`).join(" · ")}
				{rest > 0 && ` · ${t`${rest} more`}`}
			</p>
		</div>
	);
};

/**
 * A distilled cluster as the spotlight: its title and what it is made of in
 * proportions. Its arguments and their quotes are details on demand.
 */
export const ClusterSummary = ({
	distillation,
	nodes,
	conversationNames,
	actions,
}: {
	distillation: Distillation;
	/** The cluster's nodes still on the map, with their fact-check state. */
	nodes: ReadonlyArray<MapGraphNode>;
	conversationNames?: ReadonlyMap<number, string>;
	/** The affordances that open its details. */
	actions?: ReactNode;
}) => {
	const eligible = nodes.filter((node) =>
		isFactCheckEligible(attributeInputsOf(node.metadata)),
	);
	return (
		<div className="space-y-3">
			<div className="space-y-1">
				{distillation.title ? (
					<p className="leading-snug" data-testid="cluster-title">
						{distillation.title}
					</p>
				) : (
					<p className="flex items-center gap-2 leading-snug">
						<Loader size="xs" color="primary" />
						<Trans>Distilling core idea…</Trans>
					</p>
				)}
				<p className="text-xs" style={{ color: "var(--map-muted)" }}>
					{plural(nodes.length, {
						one: "# argument",
						other: "# arguments",
					})}
				</p>
			</div>
			<ShareBar
				title={t`Conversations`}
				shares={conversationShares(nodes, conversationNames)}
				testId="cluster-conversations"
			/>
			<ShareBar
				title={t`Valence`}
				shares={attributeShares(nodes, "valence")}
				testId="cluster-valence"
			/>
			<ShareBar
				title={t`Factual status`}
				shares={attributeShares(eligible, "factCheck")}
				testId="cluster-factual"
			/>
			{actions}
		</div>
	);
};
