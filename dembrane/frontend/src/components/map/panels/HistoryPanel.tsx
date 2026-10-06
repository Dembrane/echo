import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Loader, UnstyledButton } from "@mantine/core";
import { memo } from "react";
import type { Distillation } from "../hooks/useMapGroups";
import type { MapGraphNode } from "../types";
import { conversationShares } from "./ClusterSummary";
import { CaptionText, mapVars } from "./shared";

/** One step back in time: an argument clicked or a cluster distilled. */
export type HistoryItem =
	| { kind: "argument"; id: string; nodeId: string; at: number }
	| { kind: "cluster"; id: string; distillation: Distillation; at: number };

/** The nodes of a history entry that still exist, in the entry's order. */
export const resolveNodes = (
	nodeIds: ReadonlyArray<string>,
	nodesById: ReadonlyMap<string, MapGraphNode>,
): MapGraphNode[] => {
	const nodes: MapGraphNode[] = [];
	for (const id of nodeIds) {
		const node = nodesById.get(id);
		if (node) nodes.push(node);
	}
	return nodes;
};

const muted = { color: "var(--map-muted)" };

/** A thin strip of the cluster's conversations, as Spotlight draws them larger. */
const ConversationStrip = ({ nodes }: { nodes: MapGraphNode[] }) => (
	<span className="mt-1 flex h-1 w-full gap-px" aria-hidden="true">
		{conversationShares(nodes).map((share) => (
			<span
				key={share.key}
				style={{ backgroundColor: share.color, flexGrow: share.count }}
			/>
		))}
	</span>
);

const ClusterRow = ({
	distillation,
	nodes,
}: {
	distillation: Distillation;
	nodes: MapGraphNode[];
}) => {
	const count = plural(nodes.length, {
		one: "# argument",
		other: "# arguments",
	});
	switch (distillation.status) {
		case "pending":
			return (
				<>
					<span className="flex items-center gap-2 text-sm leading-tight">
						<Loader size="xs" color="primary" />
						<Trans>Distilling core idea…</Trans>
					</span>
					<span className="block text-xs" style={muted}>
						{count}
					</span>
				</>
			);
		case "failed":
			return (
				<span className="block text-sm leading-tight">
					<Trans>The title could not be generated.</Trans>
				</span>
			);
		case "too-large":
			return (
				<span className="block text-sm leading-tight">
					<Trans>This selection is too large to title.</Trans>
				</span>
			);
		default:
			return (
				<>
					<span className="block text-sm leading-tight">
						{distillation.title}
					</span>
					<span className="block text-xs" style={muted}>
						{count}
					</span>
					<ConversationStrip nodes={nodes} />
				</>
			);
	}
};

/**
 * What was spotlit before, newest first, one small row each: an argument
 * clicked or a cluster distilled. Choosing a row makes it the spotlight
 * again.
 */
export const HistoryRows = memo(function HistoryRows({
	items,
	nodesById,
	onSelect,
	onRetry,
	titles = true,
}: {
	items: ReadonlyArray<HistoryItem>;
	/** Nodes on the current map, by id. */
	nodesById: ReadonlyMap<string, MapGraphNode>;
	onSelect: (item: HistoryItem) => void;
	onRetry: (distillationId: string) => void;
	/** False where clusters are never distilled (a public room). */
	titles?: boolean;
}) {
	if (items.length === 0) {
		return (
			<CaptionText>
				{titles ? (
					<Trans>
						What you spotlight is kept here: click an argument, or rest the
						cursor on a cluster until the circle closes.
					</Trans>
				) : (
					<Trans>The arguments you click are kept here.</Trans>
				)}
			</CaptionText>
		);
	}
	return (
		<ol className="space-y-2" aria-label={t`Earlier in the spotlight`}>
			{items.map((item) => {
				const node =
					item.kind === "argument" ? nodesById.get(item.nodeId) : null;
				if (item.kind === "argument" && !node) return null;
				return (
					<li
						key={item.id}
						className="border"
						style={{ borderColor: mapVars.border }}
					>
						<UnstyledButton
							onClick={() => onSelect(item)}
							data-testid={`history-${item.kind}`}
							className="block w-full p-2 text-left"
						>
							{item.kind === "argument" ? (
								<span className="line-clamp-2 block text-sm leading-tight">
									{node?.label ?? item.nodeId}
								</span>
							) : (
								<ClusterRow
									distillation={item.distillation}
									nodes={resolveNodes(item.distillation.nodeIds, nodesById)}
								/>
							)}
						</UnstyledButton>
						{item.kind === "cluster" &&
							item.distillation.status === "failed" && (
								<div className="px-2 pb-2">
									<Button
										size="compact-xs"
										variant="subtle"
										onClick={() => onRetry(item.distillation.id)}
									>
										<Trans>Try again</Trans>
									</Button>
								</div>
							)}
					</li>
				);
			})}
		</ol>
	);
});
