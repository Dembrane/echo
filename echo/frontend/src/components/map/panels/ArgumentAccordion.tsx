import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowElbowDownRightIcon } from "@phosphor-icons/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import rows from "@/components/results/ResultsList.module.css";
import { deriveDisplayVerdict } from "../attributes";
import type { EvidenceGroup } from "../data/adapter";
import { adjacencyOf, centralityOrder } from "../graph/mst";
import {
	useMapInteraction,
	useMapInteractionStore,
} from "../state/interactionStore";
import type { Edge, MapGraphNode } from "../types";
import classes from "./ArgumentAccordion.module.css";
import { verdictLabel } from "./shared";

/** The types this list is about. Tensions and stakeholders are not arguments. */
const ARGUMENT_TYPES = new Set(["argument", "deduplicated_argument"]);

/** The list shows this many, then opens the rest in place. */
export const AT_REST = 20;

const SEPARATOR = " · ";

function evidenceWords(quotes: number, conversations: number): string {
	// The room's payload carries no evidence; say nothing rather than zero.
	if (!quotes && !conversations) return "";
	const quoteWords = plural(quotes, { one: "# quote", other: "# quotes" });
	const conversationWords = plural(conversations, {
		one: "# conversation",
		other: "# conversations",
	});
	if (!quotes) return conversationWords;
	if (!conversations) return quoteWords;
	return `${quoteWords}${SEPARATOR}${conversationWords}`;
}

export type ArgumentAccordionProps = {
	/** Every placed node; the list keeps the arguments among them. */
	nodes: ReadonlyArray<MapGraphNode>;
	/** The tree the map draws, which the ranking and the neighbours read. */
	mstEdges: ReadonlyArray<Edge>;
	/** Quotes per source conversation; empty on the room's projection. */
	evidenceFor: (nodeId: string) => EvidenceGroup[];
};

type Row = {
	node: MapGraphNode;
	neighbours: string[];
	quotes: string[];
	conversations: number;
};

/**
 * Every argument on the map as a list, most central first, each row opening
 * on its neighbours in the tree and the words behind it. The open row is the
 * selected node: opening one selects it on the map, and selecting a node on
 * the map opens its row.
 *
 * The ranking is the map's own `centralityOrder`: eccentricity in the tree
 * ascending (an argument in the middle of everything comes first), then tree
 * degree descending, then the order the payload gave, so it never wobbles.
 */
export const ArgumentAccordion = memo(function ArgumentAccordion({
	nodes,
	mstEdges,
	evidenceFor,
}: ArgumentAccordionProps) {
	const store = useMapInteractionStore();
	const selectedNodeId = useMapInteraction((state) => state.selectedNodeId);
	const [all, setAll] = useState(false);
	const list = useRef<HTMLDivElement>(null);
	const openRow = useRef<HTMLLIElement>(null);

	const ordered = useMemo<Row[]>(() => {
		const argumentNodes = nodes.filter((node) =>
			ARGUMENT_TYPES.has(node.metadata.objectType),
		);
		const byId = new Map(argumentNodes.map((node) => [node.id, node] as const));
		const adjacency = adjacencyOf(nodes, mstEdges);
		const order = centralityOrder(
			argumentNodes.map((node) => node.id),
			nodes,
			mstEdges,
		);
		return order.flatMap((id) => {
			const node = byId.get(id);
			if (!node) return [];
			const evidence = evidenceFor(id);
			return [
				{
					conversations: evidence.length,
					neighbours: Array.from(adjacency.get(id) ?? []).filter((other) =>
						byId.has(other),
					),
					node,
					quotes: evidence.flatMap((group) => group.quotes),
				},
			];
		});
	}, [evidenceFor, mstEdges, nodes]);

	const selectedIndex = ordered.findIndex(
		(row) => row.node.id === selectedNodeId,
	);
	// The selected row is always reachable, whatever the list is showing.
	const room = all
		? ordered.length
		: Math.max(AT_REST, selectedIndex + 1, 0) || AT_REST;
	const visible = ordered.slice(0, room);

	// The map and the list share one selection, so a node clicked on the map
	// opens its row here. The list only scrolls to it when the reader is
	// already looking at the list; a click on the map must not yank the page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the selection moves, which is what the open row follows
	useEffect(() => {
		const row = openRow.current;
		const container = list.current;
		if (!row || !container) return;
		const box = container.getBoundingClientRect?.();
		if (!box || box.top > globalThis.innerHeight || box.bottom < 0) return;
		row.scrollIntoView?.({ block: "nearest" });
	}, [selectedNodeId]);

	if (ordered.length === 0) return null;

	return (
		<div
			ref={list}
			className={rows.list}
			data-testid="map-argument-list"
			id="map-arguments"
		>
			<section className={rows.group}>
				<h3 className={rows.groupHead}>
					<Trans>Arguments</Trans>{" "}
					<span className={rows.count}>{ordered.length}</span>
				</h3>
				<ul className={rows.rows}>
					{visible.map((row) => {
						const open = row.node.id === selectedNodeId;
						const { consolidation, factCheck, valence } = row.node.metadata;
						const verdict =
							factCheck?.status === "done"
								? verdictLabel(deriveDisplayVerdict(factCheck))
								: null;
						return (
							<li
								className={rows.row}
								key={row.node.id}
								ref={open ? openRow : undefined}
							>
								{/* biome-ignore lint/a11y/useSemanticElements: the row holds its own control */}
								<div
									aria-expanded={open}
									className={rows.rowBody}
									data-solo=""
									data-testid={`map-argument-row-${row.node.id}`}
									onClick={() =>
										store.setSelectedNodeId(open ? null : row.node.id)
									}
									onKeyDown={(event) => {
										if (event.target !== event.currentTarget) return;
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											store.setSelectedNodeId(open ? null : row.node.id);
										}
									}}
									role="button"
									tabIndex={0}
								>
									<div className={rows.rowText}>
										<p className={`${rows.primary} ${open ? "" : rows.clamp2}`}>
											{row.node.label || row.node.id}
										</p>
										<p className={rows.second}>
											{valence === "positive" ? (
												<Trans>for</Trans>
											) : valence === "negative" ? (
												<Trans>against</Trans>
											) : null}
										</p>
									</div>
									<div className={rows.meta}>
										<p className={rows.metaLine}>
											{evidenceWords(row.quotes.length, row.conversations)}
										</p>
										{(verdict || consolidation) && (
											<p className={rows.metaState}>
												{verdict && <span>{verdict}</span>}
												{consolidation && (
													<span>
														<Trans>
															combined from {consolidation.memberCount}
														</Trans>
													</span>
												)}
											</p>
										)}
									</div>
								</div>
								{open && (
									<div className={`${rows.opened} ${classes.panel}`}>
										<div>
											<p className={classes.heading}>
												<Trans>Neighbours in the tree</Trans>
											</p>
											{row.neighbours.length === 0 ? (
												<p className={rows.second}>
													<Trans>None in this view.</Trans>
												</p>
											) : (
												<ul className={classes.neighbours}>
													{row.neighbours.map((id) => (
														<li key={id}>
															<button
																type="button"
																className={classes.neighbour}
																data-testid={`map-argument-neighbour-${id}`}
																onClick={() => store.setSelectedNodeId(id)}
															>
																<ArrowElbowDownRightIcon
																	aria-hidden
																	className={classes.arrow}
																	size="1em"
																/>
																<span className={classes.neighbourWords}>
																	{nodes.find((node) => node.id === id)
																		?.label ?? id}
																</span>
															</button>
														</li>
													))}
												</ul>
											)}
										</div>
										{/* A room's projection carries no quotes, and says nothing
										    rather than showing an empty heading. */}
										{row.quotes.length > 0 && (
											<div>
												<p className={classes.heading}>
													<Trans>Quotes</Trans>
												</p>
												<div className={classes.quotes}>
													{row.quotes.map((quote, index) => (
														<blockquote
															className={classes.quote}
															// Quotes repeat across arguments; position keeps
															// them apart.
															// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
															key={index}
														>
															{quote}
														</blockquote>
													))}
												</div>
											</div>
										)}
									</div>
								)}
							</li>
						);
					})}
				</ul>
				{!all && visible.length < ordered.length && (
					<button
						type="button"
						className={`${rows.control} ${rows.showAll}`}
						data-testid="map-arguments-show-all"
						onClick={() => setAll(true)}
					>
						<Trans>Show all {ordered.length}</Trans>
					</button>
				)}
			</section>
		</div>
	);
});
