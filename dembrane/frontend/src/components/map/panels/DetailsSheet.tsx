import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Button, Loader } from "@mantine/core";
import { XIcon } from "@phosphor-icons/react";
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { cn } from "@/lib/utils";
import { conversationColor, MAP_NEUTRAL_GREY } from "../attributes";
import type { EvidenceGroup } from "../data/adapter";
import type { Distillation } from "../hooks/useMapGroups";
import { RELATION_DASH, relationStroke } from "../renderers/relations";
import type { ColorBy, Edge, MapGraphNode, MapRelation } from "../types";
import classes from "./DetailsSheet.module.css";
import {
	KnowledgeGraph,
	type KnowledgeNode,
	knowledgeGraph,
	quoteKey,
	type Voice,
	voicesOf,
} from "./KnowledgeGraph";
import type { ConversationHref } from "./NodeDetailCard";
import type { DetailsFrom } from "./SpotlightPanel";
import { basisLabel, mapVars, relationLabel } from "./shared";

export type DetailsTarget =
	| { kind: "argument"; node: MapGraphNode }
	| { kind: "cluster"; distillation: Distillation; nodes: MapGraphNode[] };

/** How the sheet was asked for: which way in, and a count so asking again moves it. */
export type DetailsRequest = { from: DetailsFrom; at: number };

/** How many of an argument's quotes show before "Show all". */
export const FIRST_QUOTES = 2;

/** How many steps the trail keeps; the first, the item opened, always stays. */
export const TRAIL_STEPS = 4;

/** Where the sheet stands: on the cluster it was opened on, or on one argument. */
export type Focus = { kind: "cluster" } | { kind: "argument"; id: string };

/** One quote picked in the graph, to mark in the panel. */
type Mark = { nodeId: string; index: number } | null;

const MUTED = "var(--map-muted)";

const sameFocus = (a: Focus, b: Focus) =>
	a.kind === "cluster"
		? b.kind === "cluster"
		: b.kind === "argument" && a.id === b.id;

/**
 * The trail after a travel. Going to a step already on it goes back to that
 * step; anything else is added. The item the sheet was opened on stays first,
 * then the latest steps, so the trail never holds more than `TRAIL_STEPS`.
 */
export const travelTo = (trail: ReadonlyArray<Focus>, next: Focus): Focus[] => {
	const at = trail.findIndex((step) => sameFocus(step, next));
	if (at >= 0) return trail.slice(0, at + 1);
	const longer = [...trail, next];
	if (longer.length <= TRAIL_STEPS) return longer;
	return [longer[0], ...longer.slice(-(TRAIL_STEPS - 1))];
};

/** One quote as people read it: the words, then where they were said. */
const VoiceCard = ({
	voice,
	marked,
	conversationHref,
	id,
	first,
}: {
	voice: Voice;
	marked: boolean;
	conversationHref?: ConversationHref;
	id: string;
	/** The first card leans on the list's top rule; the rest draw one between. */
	first: boolean;
}) => {
	const { group, text } = voice;
	const href = conversationHref?.(group.conversationId) ?? null;
	return (
		<li
			className={cn("flex gap-2 px-2 py-4", !first && "border-t")}
			data-quote-id={id}
			data-selected={marked || undefined}
			style={{
				backgroundColor: marked ? mapVars.accentSurface : undefined,
				borderColor: mapVars.border,
			}}
		>
			{/* The dot the legend, the map and the graph give this conversation. */}
			<ConversationDot group={group} />
			<div className="min-w-0 flex-1 space-y-1">
				<blockquote className="text-sm leading-relaxed">{text}</blockquote>
				{href ? (
					<Anchor
						component={I18nLink}
						to={href}
						size="xs"
						// The map's own link colour, lifted where the map is dark.
						style={{ color: mapVars.accentText }}
					>
						{group.label}
					</Anchor>
				) : (
					<p className="text-xs" style={{ color: MUTED }}>
						{group.label}
					</p>
				)}
			</div>
		</li>
	);
};

const ConversationDot = ({ group }: { group: EvidenceGroup }) => (
	<span
		aria-hidden
		className="mt-2 inline-block size-2 shrink-0 rounded-full"
		data-testid={group.slot === null ? undefined : `voice-slot-${group.slot}`}
		style={{
			backgroundColor:
				group.slot === null ? MAP_NEUTRAL_GREY : conversationColor(group.slot),
		}}
	/>
);

/** An argument's quotes, the first few open, then "Show all N". */
const QuoteList = ({
	node,
	voices,
	expanded,
	onExpand,
	mark,
	conversationHref,
}: {
	node: MapGraphNode;
	voices: Voice[];
	expanded: boolean;
	onExpand: () => void;
	mark: Mark;
	conversationHref?: ConversationHref;
}) => {
	const shown = expanded ? voices : voices.slice(0, FIRST_QUOTES);
	if (voices.length === 0) {
		return (
			<p className="text-xs" style={{ color: MUTED }}>
				<Trans>No quotes for this argument.</Trans>
			</p>
		);
	}
	return (
		<div className="space-y-2">
			<ul className="border-y" style={{ borderColor: mapVars.border }}>
				{shown.map((voice, index) => {
					const id = quoteKey(node.id, index);
					return (
						<VoiceCard
							key={id}
							id={id}
							first={index === 0}
							voice={voice}
							marked={mark?.nodeId === node.id && mark.index === index}
							conversationHref={conversationHref}
						/>
					);
				})}
			</ul>
			{!expanded && voices.length > FIRST_QUOTES && (
				<Button variant="subtle" size="compact-sm" onClick={onExpand}>
					<Trans>Show all {voices.length}</Trans>
				</Button>
			)}
		</div>
	);
};

/** "From N quotes in M conversations", or that there are none yet. */
const CountLine = ({
	quoteCount,
	conversationCount,
}: {
	quoteCount: number;
	conversationCount: number;
}) => {
	return (
		<p className="text-xs" style={{ color: MUTED }} data-testid="sheet-count">
			{quoteCount > 0 ? (
				<Trans>
					From <Plural value={quoteCount} one="# quote" other="# quotes" /> in{" "}
					<Plural
						value={conversationCount}
						one="# conversation"
						other="# conversations"
					/>
				</Trans>
			) : (
				<Trans>No quotes yet</Trans>
			)}
		</p>
	);
};

const conversationsBehind = (
	ids: ReadonlyArray<string>,
	evidenceFor: (nodeId: string) => EvidenceGroup[],
) =>
	new Set(
		ids.flatMap((id) =>
			evidenceFor(id)
				.filter((group) => group.quotes.length > 0)
				.map((group) => group.conversationId),
		),
	).size;

/** The focused argument's relationships, each drawn with the graph's dash. */
const RelationList = ({
	focusId,
	relations,
	nodesById,
	darkMode,
	onTravel,
}: {
	focusId: string;
	relations: ReadonlyArray<MapRelation>;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	darkMode: boolean;
	onTravel: (nodeId: string) => void;
}) => {
	const seen = new Set<string>();
	const items = relations.flatMap((relation) => {
		if (seen.has(relation.id)) return [];
		if (relation.source !== focusId && relation.target !== focusId) return [];
		seen.add(relation.id);
		const otherId =
			relation.source === focusId ? relation.target : relation.source;
		return [{ otherId, relation }];
	});
	if (items.length === 0) return null;
	return (
		<div className="space-y-2">
			<p className="text-xs" style={{ color: MUTED }}>
				<Trans>Relationships</Trans>
			</p>
			<ul className="space-y-2" data-testid="sheet-relations">
				{items.map(({ otherId, relation }) => {
					const other = nodesById.get(otherId);
					const label = other?.label ?? t`An object outside this view`;
					return (
						<li key={relation.id} className="flex items-start gap-2">
							<svg
								aria-hidden="true"
								width={16}
								height={8}
								className="mt-2 shrink-0"
							>
								<line
									x1={0}
									y1={4}
									x2={16}
									y2={4}
									strokeWidth={1}
									strokeDasharray={RELATION_DASH}
									style={{ stroke: relationStroke(darkMode) }}
								/>
							</svg>
							<div className="min-w-0 flex-1 space-y-1">
								{other ? (
									<button
										type="button"
										className={cn(classes.travel, "text-sm leading-snug")}
										style={{ color: mapVars.accentText }}
										onClick={() => onTravel(otherId)}
										data-testid={`sheet-relation-${otherId}`}
									>
										{label}
									</button>
								) : (
									<p className="text-sm leading-snug">{label}</p>
								)}
								<p className="text-xs" style={{ color: MUTED }}>
									{relationLabel(relation.type)} · {basisLabel(relation.basis)}
								</p>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
};

type BodyProps = {
	target: DetailsTarget;
	request: DetailsRequest;
	evidenceFor: (nodeId: string) => EvidenceGroup[];
	conversationHref?: ConversationHref;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	edges: ReadonlyArray<Edge>;
	relations: ReadonlyArray<MapRelation>;
	colorBy: ColorBy;
	darkMode: boolean;
	onMark: (nodeIds: string[]) => void;
};

/**
 * Everything under the sheet's header: the trail, the graph and the focused
 * panel. It starts again whenever the sheet is opened or handed a new item.
 */
const SheetBody = ({
	target,
	request,
	evidenceFor,
	conversationHref,
	nodesById,
	edges,
	relations,
	colorBy,
	darkMode,
	onMark,
}: BodyProps) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const focusTitleId = useId();

	const root: Focus =
		target.kind === "cluster"
			? { kind: "cluster" }
			: { id: target.node.id, kind: "argument" };
	const [trail, setTrail] = useState<Focus[]>(() => [root]);
	const [mark, setMark] = useState<Mark>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// Opened from a cluster's Quotes, the sheet opens on all of them.
	const [allQuotes, setAllQuotes] = useState(
		target.kind === "cluster" && request.from === "quotes",
	);
	const revealPending = useRef(false);

	const nodeOf = (id: string): MapGraphNode | undefined =>
		nodesById.get(id) ??
		(target.kind === "argument" && target.node.id === id
			? target.node
			: undefined);

	const last = trail[trail.length - 1];
	// A step whose argument left the map falls back to where the sheet began.
	const focus: Focus =
		last.kind === "argument" && !nodeOf(last.id) ? root : last;
	const focusNode = focus.kind === "argument" ? nodeOf(focus.id) : undefined;
	const clusterNodes = target.kind === "cluster" ? target.nodes : [];
	const clusterKey = clusterNodes.map((node) => node.id).join(",");
	const focusKey =
		focus.kind === "cluster" ? `cluster:${clusterKey}` : focus.id;

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the focus
	const focusIds = useMemo(
		() =>
			focus.kind === "cluster"
				? clusterNodes.map((node) => node.id)
				: [focus.id],
		[focusKey],
	);
	const graph = useMemo(
		() =>
			knowledgeGraph({
				edges,
				evidenceFor,
				expand: focus.kind === "argument",
				focusIds,
				// The opened argument is drawn even where it is not on the map.
				nodesById:
					focusNode && !nodesById.has(focusNode.id)
						? new Map([...nodesById, [focusNode.id, focusNode]])
						: nodesById,
				relations,
			}),
		[edges, evidenceFor, focusIds, focusNode, nodesById, relations, focus.kind],
	);

	const voicesFor = useCallback(
		(id: string) => voicesOf(evidenceFor(id)),
		[evidenceFor],
	);
	const expand = useCallback(
		(id: string) => setExpanded((current) => new Set(current).add(id)),
		[],
	);

	const travel = useCallback(
		(next: Focus) => {
			setTrail((current) => travelTo(current, next));
			setMark(null);
			setAllQuotes(false);
			revealPending.current = true;
			onMark(
				next.kind === "cluster"
					? clusterNodes.map((node) => node.id)
					: [next.id],
			);
		},
		[clusterNodes, onMark],
	);
	const travelToArgument = useCallback(
		(id: string) => travel({ id, kind: "argument" }),
		[travel],
	);

	// Nothing scrolls by itself on a click. Only where the reader had scrolled
	// past the top of the panel does the sheet come back to it, so the new
	// focus is read from its name; only the sheet's own scrollTop moves.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the focus moves
	useEffect(() => {
		if (!revealPending.current) return;
		revealPending.current = false;
		const container = scrollRef.current;
		const panel = panelRef.current;
		if (!container || !panel || container.clientHeight === 0) return;
		const view = container.getBoundingClientRect();
		const top = panel.getBoundingClientRect().top;
		if (top < view.top) container.scrollTop += top - view.top;
	}, [focusKey]);

	const pick = useCallback(
		(node: KnowledgeNode) => {
			if (node.kind === "quote") {
				// A quote is marked where it is read; the graph stays put.
				if (node.index >= FIRST_QUOTES) expand(node.nodeId);
				if (focus.kind === "cluster") setAllQuotes(true);
				setMark({ index: node.index, nodeId: node.nodeId });
				return;
			}
			if (focus.kind === "argument" && focus.id === node.nodeId) return;
			travelToArgument(node.nodeId);
		},
		[expand, focus, travelToArgument],
	);

	const markedId =
		mark && (focus.kind === "cluster" || mark.nodeId === focus.id)
			? quoteKey(mark.nodeId, mark.index)
			: focus.kind === "argument"
				? focus.id
				: null;

	const stepLabel = (step: Focus): string =>
		step.kind === "cluster"
			? target.kind === "cluster" && target.distillation.title
				? target.distillation.title
				: t`Cluster`
			: (nodeOf(step.id)?.label ?? step.id);

	let panel: ReactNode;
	let panelLabel: { "aria-label"?: string; "aria-labelledby"?: string };
	if (focus.kind === "argument" && focusNode) {
		const voices = voicesFor(focusNode.id);
		panelLabel = { "aria-labelledby": focusTitleId };
		panel = (
			<article
				className="space-y-4"
				data-argument-id={focusNode.id}
				data-testid="sheet-focus"
			>
				<div className="space-y-1">
					<h3
						id={focusTitleId}
						className="text-sm leading-snug"
						data-testid="sheet-focus-title"
					>
						{focusNode.label ?? focusNode.id}
					</h3>
					<CountLine
						quoteCount={voices.length}
						conversationCount={conversationsBehind([focusNode.id], evidenceFor)}
					/>
				</div>
				<QuoteList
					node={focusNode}
					voices={voices}
					expanded={expanded.has(focusNode.id)}
					onExpand={() => expand(focusNode.id)}
					mark={mark}
					conversationHref={conversationHref}
				/>
				<RelationList
					focusId={focusNode.id}
					relations={relations}
					nodesById={nodesById}
					darkMode={darkMode}
					onTravel={travelToArgument}
				/>
			</article>
		);
	} else {
		const ids = clusterNodes.map((node) => node.id);
		const quotes = ids.reduce((total, id) => total + voicesFor(id).length, 0);
		panelLabel = { "aria-label": allQuotes ? t`Quotes` : t`Arguments` };
		panel = (
			<div className="space-y-4" data-testid="sheet-cluster">
				<div className="flex items-center gap-4">
					<div className="min-w-0 flex-1">
						<CountLine
							quoteCount={quotes}
							conversationCount={conversationsBehind(ids, evidenceFor)}
						/>
					</div>
					<Button
						size="compact-sm"
						aria-pressed={allQuotes}
						onClick={() => setAllQuotes((open) => !open)}
						vars={() => ({
							root: {
								"--button-bd": `1px solid ${
									allQuotes ? mapVars.accentBorder : mapVars.border
								}`,
								"--button-bg": allQuotes
									? mapVars.accentSurface
									: mapVars.surface,
								"--button-color": mapVars.text,
								"--button-hover": mapVars.card,
								"--button-hover-color": mapVars.text,
							},
						})}
					>
						<Trans>All quotes</Trans>
					</Button>
				</div>
				{allQuotes ? (
					<div className="space-y-8" data-testid="sheet-all-quotes">
						{clusterNodes.map((node) => (
							<article
								key={node.id}
								className="space-y-2"
								data-argument-id={node.id}
							>
								<h3 className="text-sm leading-snug">
									<button
										type="button"
										className={classes.travel}
										style={{ color: mapVars.accentText }}
										onClick={() => travelToArgument(node.id)}
									>
										{node.label ?? node.id}
									</button>
								</h3>
								<QuoteList
									node={node}
									voices={voicesFor(node.id)}
									expanded={expanded.has(node.id)}
									onExpand={() => expand(node.id)}
									mark={mark}
									conversationHref={conversationHref}
								/>
							</article>
						))}
					</div>
				) : (
					<ul className="border-y" style={{ borderColor: mapVars.border }}>
						{clusterNodes.map((node, index) => {
							const first = voicesFor(node.id)[0];
							return (
								<li
									key={node.id}
									className={cn(index > 0 && "border-t")}
									style={{ borderColor: mapVars.border }}
								>
									<button
										type="button"
										className={cn(classes.travel, classes.row, "space-y-1")}
										onClick={() => travelToArgument(node.id)}
										data-testid={`sheet-argument-${node.id}`}
									>
										<span
											className="block text-sm leading-snug"
											style={{ color: mapVars.accentText }}
										>
											{node.label ?? node.id}
										</span>
										{first && (
											<span className="flex gap-2">
												<ConversationDot group={first.group} />
												<span className="line-clamp-2 min-w-0 flex-1 text-sm leading-relaxed">
													{first.text}
												</span>
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className="min-h-0 flex-1 overflow-y-auto px-4 pb-8"
			data-testid="sheet-scroll"
		>
			<section className="py-4" aria-label={t`Connections`}>
				{/* The trail's row is kept at the start too, so the graph does
				    not move down on the first travel. */}
				<div
					className="pb-2 text-xs"
					style={{ minHeight: "calc(1.45em + 0.5rem)" }}
				>
					{trail.length > 1 && (
						<nav
							aria-label={t`Trail`}
							className="flex min-w-0 items-center gap-1"
							data-testid="sheet-trail"
						>
							{trail.map((step, index) => {
								const label = stepLabel(step);
								const key = step.kind === "cluster" ? "cluster" : step.id;
								return (
									<Fragment key={key}>
										{index > 0 && (
											<span aria-hidden style={{ color: MUTED }}>
												›
											</span>
										)}
										{index === trail.length - 1 ? (
											<span
												aria-current="location"
												className={classes.step}
												style={{ color: mapVars.text }}
												title={label}
											>
												{label}
											</span>
										) : (
											<button
												type="button"
												className={cn(classes.travel, classes.step)}
												style={{ color: MUTED }}
												title={label}
												onClick={() => travel(step)}
											>
												{label}
											</button>
										)}
									</Fragment>
								);
							})}
						</nav>
					)}
				</div>
				<KnowledgeGraph
					graph={graph}
					nodesById={nodesById}
					colorBy={colorBy}
					darkMode={darkMode}
					marked={markedId}
					centre={focus.kind === "argument" ? focus.id : null}
					onPick={pick}
				/>
			</section>

			<section
				ref={panelRef}
				className="border-t pt-4"
				style={{ borderColor: mapVars.border }}
				data-testid="sheet-panel"
				{...panelLabel}
			>
				{panel}
			</section>
		</div>
	);
};

/**
 * A cluster's or an argument's details, as a sheet over the right of the map.
 * The knowledge graph navigates: picking an argument travels to it, centred
 * with its neighbours, and the panel under the graph holds that argument with
 * its quotes and relationships. A trail above the graph steps back. The main
 * map marks the same argument and nothing else moves. Escape or the close
 * button puts the sheet away.
 */
export const DetailsSheet = ({
	target,
	request,
	onClose,
	evidenceFor,
	conversationHref,
	provenance = true,
	nodesById,
	edges,
	relations,
	colorBy,
	darkMode,
	onMark,
}: {
	target: DetailsTarget;
	request: DetailsRequest;
	onClose: () => void;
	evidenceFor: (nodeId: string) => EvidenceGroup[];
	conversationHref?: ConversationHref;
	/** False in the room: no quote links back into the workspace. */
	provenance?: boolean;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	edges: ReadonlyArray<Edge>;
	relations: ReadonlyArray<MapRelation>;
	colorBy: ColorBy;
	darkMode: boolean;
	/** Marks the focus on the main map, without selecting or scrolling anything. */
	onMark: (nodeIds: string[]) => void;
}) => {
	const titleId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const href = provenance === false ? undefined : conversationHref;
	const rootKey =
		target.kind === "cluster"
			? `cluster:${target.distillation.id}`
			: `argument:${target.node.id}`;

	// Escape puts the sheet away, from anywhere on the page.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	// Focus moves into the sheet when it opens and back where it came from
	// when it closes, and neither moves the page.
	useEffect(() => {
		const opener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		headingRef.current?.focus({ preventScroll: true });
		return () => {
			if (opener?.isConnected) opener.focus({ preventScroll: true });
		};
	}, []);

	const title =
		target.kind === "argument" ? (
			(target.node.label ?? target.node.id)
		) : target.distillation.title ? (
			target.distillation.title
		) : (
			<span className="flex items-center gap-2">
				<Loader size="xs" color="primary" />
				<Trans>Distilling core idea…</Trans>
			</span>
		);

	const style: CSSProperties = {
		// Raised off the map, so the sheet reads as a layer over it in both
		// themes; the shadow is the one a floating layer may have.
		backgroundColor: mapVars.raised,
		borderColor: mapVars.border,
		boxShadow: "var(--mantine-shadow-md)",
		color: mapVars.text,
		width: "max(40%, 320px)",
	};

	return (
		<aside
			role="dialog"
			aria-modal="false"
			aria-labelledby={titleId}
			className="absolute inset-y-0 right-0 z-20 flex max-w-full flex-col border-y"
			style={style}
			data-testid="details-sheet"
		>
			<header
				className="flex shrink-0 items-start gap-4 border-b p-4"
				style={{ borderColor: mapVars.border }}
			>
				<h2
					ref={headingRef}
					id={titleId}
					tabIndex={-1}
					className="min-w-0 flex-1 text-base leading-snug outline-none"
					data-testid="sheet-title"
				>
					{title}
				</h2>
				<ActionIcon
					variant="default"
					radius={0}
					onClick={onClose}
					aria-label={t`Close`}
					vars={() => ({
						root: {
							"--ai-bd": `1px solid ${mapVars.border}`,
							"--ai-bg": mapVars.surface,
							"--ai-color": mapVars.text,
							"--ai-hover": mapVars.card,
						},
					})}
				>
					<XIcon size={20} />
				</ActionIcon>
			</header>

			<SheetBody
				// Opened again, or handed a new item, the sheet starts at the item.
				key={`${rootKey}@${request.at}`}
				target={target}
				request={request}
				evidenceFor={evidenceFor}
				conversationHref={href}
				nodesById={nodesById}
				edges={edges}
				relations={relations}
				colorBy={colorBy}
				darkMode={darkMode}
				onMark={onMark}
			/>
		</aside>
	);
};
