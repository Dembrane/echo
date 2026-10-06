import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Button, Loader } from "@mantine/core";
import { XIcon } from "@phosphor-icons/react";
import {
	type CSSProperties,
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
import type { ColorBy, Edge, MapGraphNode, MapRelation } from "../types";
import {
	KnowledgeGraph,
	type KnowledgeNode,
	knowledgeGraph,
	quoteKey,
	type Voice,
	voicesOf,
} from "./KnowledgeGraph";
import {
	type ConversationHref,
	NodeDetailCard,
	type NodeInspection,
} from "./NodeDetailCard";
import type { DetailsFrom } from "./SpotlightPanel";
import { mapVars } from "./shared";

export type DetailsTarget =
	| { kind: "argument"; node: MapGraphNode; inspection: NodeInspection | null }
	| { kind: "cluster"; distillation: Distillation; nodes: MapGraphNode[] };

/** How the sheet was asked for: which way in, and a count so asking again moves it. */
export type DetailsRequest = { from: DetailsFrom; at: number };

/** How many of an argument's quotes show before "Show all". */
export const FIRST_QUOTES = 2;

/** What was picked last: an argument (all its quotes) or one quote. */
type Mark = { nodeId: string; index: number | null } | null;

const MUTED = "var(--map-muted)";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	typeof window.matchMedia === "function" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scrolls `element` to the top of `container`, inside the sheet only. */
const scrollWithin = (container: HTMLElement, element: HTMLElement) => {
	const top = Math.max(
		0,
		element.getBoundingClientRect().top -
			container.getBoundingClientRect().top +
			container.scrollTop -
			16,
	);
	if (typeof container.scrollTo === "function") {
		container.scrollTo({
			behavior: prefersReducedMotion() ? "auto" : "smooth",
			top,
		});
	} else {
		container.scrollTop = top;
	}
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
			<span
				aria-hidden
				className="mt-2 inline-block size-2 shrink-0 rounded-full"
				data-testid={
					group.slot === null ? undefined : `voice-slot-${group.slot}`
				}
				style={{
					backgroundColor:
						group.slot === null
							? MAP_NEUTRAL_GREY
							: conversationColor(group.slot),
				}}
			/>
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

/** An argument and its quotes, the first few open. */
const ArgumentVoices = ({
	node,
	voices,
	expanded,
	onExpand,
	mark,
	conversationHref,
	heading,
}: {
	node: MapGraphNode;
	voices: Voice[];
	expanded: boolean;
	onExpand: () => void;
	mark: Mark;
	conversationHref?: ConversationHref;
	/** False where the sheet's own header already states the argument. */
	heading: boolean;
}) => {
	const argumentMarked = mark?.nodeId === node.id && mark.index === null;
	const shown = expanded ? voices : voices.slice(0, FIRST_QUOTES);
	return (
		<article
			className="space-y-4"
			data-argument-id={node.id}
			data-selected={argumentMarked || undefined}
		>
			{heading && (
				<h3
					className="text-sm leading-snug"
					style={argumentMarked ? { color: mapVars.accentText } : undefined}
				>
					{node.label ?? node.id}
				</h3>
			)}
			{voices.length > 0 ? (
				<ul className="border-y" style={{ borderColor: mapVars.border }}>
					{shown.map((voice, index) => {
						const id = quoteKey(node.id, index);
						return (
							<VoiceCard
								key={id}
								id={id}
								first={index === 0}
								voice={voice}
								marked={
									mark?.nodeId === node.id &&
									(mark.index === null || mark.index === index)
								}
								conversationHref={conversationHref}
							/>
						);
					})}
				</ul>
			) : (
				<p className="text-xs" style={{ color: MUTED }}>
					<Trans>No quotes for this argument.</Trans>
				</p>
			)}
			{!expanded && voices.length > FIRST_QUOTES && (
				<Button variant="subtle" size="compact-sm" onClick={onExpand}>
					<Trans>Show all {voices.length}</Trans>
				</Button>
			)}
		</article>
	);
};

/**
 * A cluster's or an argument's details, as a sheet over the right of the map:
 * who said it, the knowledge graph of its arguments and quotes, then the
 * quotes themselves, grouped by argument. Picking anything in the graph lands
 * on its words. Escape or the close button puts the sheet away.
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
	onSelect,
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
	/** Spotlights a node; the sheet then follows it. */
	onSelect: (nodeId: string) => void;
}) => {
	const titleId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const voicesRef = useRef<HTMLElement>(null);
	const href = provenance === false ? undefined : conversationHref;

	const focusNodes = target.kind === "argument" ? [target.node] : target.nodes;
	const focusKey = focusNodes.map((node) => node.id).join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the focus ids
	const focusIds = useMemo(() => focusNodes.map((node) => node.id), [focusKey]);
	const voicesById = useMemo(
		() => new Map(focusIds.map((id) => [id, voicesOf(evidenceFor(id))])),
		[evidenceFor, focusIds],
	);
	const quoteCount = [...voicesById.values()].reduce(
		(total, voices) => total + voices.length,
		0,
	);
	const conversationCount = new Set(
		focusIds.flatMap((id) =>
			evidenceFor(id)
				.filter((group) => group.quotes.length > 0)
				.map((group) => group.conversationId),
		),
	).size;

	const graph = useMemo(
		() =>
			knowledgeGraph({
				edges,
				evidenceFor,
				expand: target.kind === "argument",
				focusIds,
				nodesById,
				relations,
			}),
		[edges, evidenceFor, focusIds, nodesById, relations, target.kind],
	);

	const [mark, setMark] = useState<Mark>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// A new item starts unmarked and folded.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the focus ids
	useEffect(() => {
		setMark(null);
		setExpanded(new Set());
	}, [focusKey]);

	// Escape puts the sheet away, from anywhere on the page.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	// Focus moves into the sheet when it opens and back where it came from
	// when it closes.
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

	// Quotes and Arguments open on the words; Connections on the graph.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per request and per item
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) return;
		if (request.from === "connections") {
			container.scrollTop = 0;
			return;
		}
		if (voicesRef.current) scrollWithin(container, voicesRef.current);
	}, [request.at, request.from, focusKey]);

	// A pick scrolls its words into view once they are drawn.
	useEffect(() => {
		const container = scrollRef.current;
		if (!mark || !container) return;
		const [attribute, value] =
			mark.index === null
				? ["data-argument-id", mark.nodeId]
				: ["data-quote-id", quoteKey(mark.nodeId, mark.index)];
		const element = [
			...container.querySelectorAll<HTMLElement>(`[${attribute}]`),
		].find((candidate) => candidate.getAttribute(attribute) === value);
		if (element) scrollWithin(container, element);
	}, [mark]);

	const pick = useCallback(
		(node: KnowledgeNode) => {
			if (node.kind === "quote") {
				if (node.index >= FIRST_QUOTES) {
					setExpanded((current) => new Set(current).add(node.nodeId));
				}
				setMark({ index: node.index, nodeId: node.nodeId });
				return;
			}
			// A neighbour of a single argument becomes the spotlight, and the
			// sheet follows it.
			if (!node.focus) {
				onSelect(node.nodeId);
				return;
			}
			setMark({ index: null, nodeId: node.nodeId });
		},
		[onSelect],
	);

	const markedId = mark
		? mark.index === null
			? mark.nodeId
			: quoteKey(mark.nodeId, mark.index)
		: null;

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
				<div className="min-w-0 flex-1 space-y-1">
					<h2
						ref={headingRef}
						id={titleId}
						tabIndex={-1}
						className="text-base leading-snug outline-none"
						data-testid="sheet-title"
					>
						{title}
					</h2>
					<p
						className="text-xs"
						style={{ color: MUTED }}
						data-testid="sheet-count"
					>
						{quoteCount > 0 ? (
							<Trans>
								From{" "}
								<Plural value={quoteCount} one="# quote" other="# quotes" /> in{" "}
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
				</div>
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

			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-y-auto px-4 pb-8"
				data-testid="sheet-scroll"
			>
				<section className="py-4" aria-label={t`Connections`}>
					<KnowledgeGraph
						graph={graph}
						nodesById={nodesById}
						colorBy={colorBy}
						darkMode={darkMode}
						marked={markedId}
						onPick={pick}
					/>
				</section>

				<section
					ref={voicesRef}
					// A cluster's first argument title sits under a rule; an
					// argument's own quotes bring theirs.
					className={cn(
						"space-y-8",
						target.kind === "cluster" && "border-t pt-4",
					)}
					style={{ borderColor: mapVars.border }}
					aria-label={t`Quotes`}
					data-testid="sheet-voices"
				>
					{focusNodes.map((node) => (
						<ArgumentVoices
							key={node.id}
							node={node}
							voices={voicesById.get(node.id) ?? []}
							expanded={expanded.has(node.id)}
							onExpand={() =>
								setExpanded((current) => new Set(current).add(node.id))
							}
							mark={mark}
							conversationHref={href}
							heading={target.kind === "cluster"}
						/>
					))}
				</section>
				{/* What an argument's kind adds: poles, members, relationships. */}
				{target.kind === "argument" && (
					<section className="pt-8">
						<NodeDetailCard
							node={target.node}
							evidence={evidenceFor(target.node.id)}
							conversationHref={href}
							statement={false}
							quotes={false}
							inspection={target.inspection}
						/>
					</section>
				)}
			</div>
		</aside>
	);
};
