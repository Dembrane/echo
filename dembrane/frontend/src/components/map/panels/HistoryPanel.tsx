import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Loader, UnstyledButton } from "@mantine/core";
import { memo } from "react";
import type { Distillation } from "../hooks/useSelectionTitle";
import type { MapGraphNode } from "../types";
import { conversationShares } from "./ClusterSummary";
import { CaptionText, mapVars, PanelHeader } from "./shared";

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
 * The way back: every argument clicked and every cluster distilled this
 * session, newest first. Choosing one brings it back into Spotlight.
 */
export const HistoryPanel = memo(function HistoryPanel({
	items,
	nodesById,
	selectedId,
	onSelect,
	onRetry,
}: {
	items: ReadonlyArray<HistoryItem>;
	/** Nodes on the current map, by id. */
	nodesById: ReadonlyMap<string, MapGraphNode>;
	selectedId: string | null;
	onSelect: (item: HistoryItem) => void;
	onRetry: (distillationId: string) => void;
}) {
	return (
		<section
			id="history-panel"
			className="flex h-full min-h-0 flex-col"
			aria-label={t`History`}
		>
			<PanelHeader title={<Trans>History</Trans>} dotClassName="bg-primary" />
			<div className="min-h-0 flex-1 overflow-y-auto pr-1">
				{items.length === 0 ? (
					<CaptionText>
						<Trans>
							Click an argument, or rest the cursor on a cluster until the
							circle closes, and it is kept here.
						</Trans>
					</CaptionText>
				) : (
					<ol className="space-y-2">
						{items.map((item) => {
							const selected = item.id === selectedId;
							const node =
								item.kind === "argument" ? nodesById.get(item.nodeId) : null;
							if (item.kind === "argument" && !node) return null;
							return (
								<li
									key={item.id}
									className="border transition-colors"
									style={{
										backgroundColor: selected
											? mapVars.accentSurface
											: undefined,
										borderColor: selected
											? mapVars.accentBorder
											: mapVars.border,
									}}
								>
									<UnstyledButton
										onClick={() => onSelect(item)}
										aria-pressed={selected}
										data-selected={selected || undefined}
										data-testid={`history-${item.kind}`}
										className="block w-full p-3 text-left"
									>
										{item.kind === "argument" ? (
											<>
												<span className="block text-xs" style={muted}>
													<Trans>Argument</Trans>
												</span>
												<span className="line-clamp-2 block text-sm leading-tight">
													{node?.label ?? item.nodeId}
												</span>
											</>
										) : (
											<ClusterRow
												distillation={item.distillation}
												nodes={resolveNodes(
													item.distillation.nodeIds,
													nodesById,
												)}
											/>
										)}
									</UnstyledButton>
									{item.kind === "cluster" &&
										item.distillation.status === "failed" && (
											<div className="px-3 pb-3">
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
				)}
			</div>
		</section>
	);
});
