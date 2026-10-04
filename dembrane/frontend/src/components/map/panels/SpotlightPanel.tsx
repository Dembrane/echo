import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Button, UnstyledButton } from "@mantine/core";
import { type CSSProperties, memo } from "react";
import { primaryText, resultFields } from "@/components/results";
import { cn } from "@/lib/utils";
import {
	ATTRIBUTES,
	attributeInputsOf,
	conversationColor,
	conversationColors,
	conversationSlotLabel,
	FACT_CHECKABLE_TYPES,
	isFactCheckEligible,
	slotKey,
} from "../attributes";
import type { EvidenceGroup } from "../data/adapter";
import type { Distillation } from "../hooks/useSelectionTitle";
import { deriveDisplayVerdict } from "../graph/nodeStyle";
import { blendBackground } from "../renderers/gradients";
import { ClusterSummary } from "./ClusterSummary";
import type { ColorBy, FactCheckState, MapGraphNode } from "../types";
import {
	type ConversationHref,
	NodeDetailCard,
	type NodeInspection,
} from "./NodeDetailCard";
import {
	CaptionText,
	CHIP_CLASS,
	formatTimestamp,
	OPINION_CHIP_CLASS,
	OPINION_CHIP_STYLE,
	PanelHeader,
	pressableChipStyle,
	VERDICT_CHIP_CLASS,
	valenceBlurb,
	valenceChipClass,
	valenceChipStyle,
	valenceLabel,
	verdictLabel,
} from "./shared";

type SpotlightPanelProps = {
	node: MapGraphNode | null;
	evidence: EvidenceGroup[];
	/** The claim's current state; undefined when not eligible. */
	factCheck: FactCheckState | undefined;
	colorBy: ColorBy;
	onColorByChange: (colorBy: ColorBy) => void;
	/** False for read-only roles: verdicts show, controls do not. */
	canFactCheck: boolean;
	onFactCheck: (nodeId: string, options?: { force?: boolean }) => void;
	onCancelFactCheck: (nodeId: string) => void;
	conversationHref?: ConversationHref;
	/**
	 * What to call the conversation in a palette slot. The host map has every
	 * name; the room's has them only where the presentation says the room may
	 * read them, and the rest are named by their place.
	 */
	conversationNames?: ReadonlyMap<number, string>;
	locale?: string;
	inspection?: NodeInspection | null;
	/** A distilled cluster to show instead of the node. */
	cluster?: { distillation: Distillation; nodes: MapGraphNode[] } | null;
	onSelectNode?: (nodeId: string) => void;
};

/**
 * Ink on a marker colour: the deck's `--on-marker`, which is graphite and
 * stays graphite in both themes, because a marker is an object in the room
 * rather than a surface of the page.
 */
const ON_MARKER_CLASS = "text-graphite";

/** How many conversations get a chit of their own before they are counted. */
const NAMED_CHITS = 3;

/**
 * The conversations behind the node, in the colours the map gives them: one
 * chit each while they can be told apart, and past that a single chit in the
 * node's own weighted blend. Clicking any of them colours the map by
 * conversation.
 */
const ConversationChits = ({
	slots,
	names,
	active,
	onToggle,
}: {
	/** Palette slots behind the node, one entry per contributing member. */
	slots: ReadonlyArray<number>;
	names?: ReadonlyMap<number, string>;
	active: boolean;
	onToggle: () => void;
}) => {
	if (slots.length === 0) return null;
	const unique = Array.from(new Set(slots)).sort((a, b) => a - b);
	const title = active
		? t`Stop coloring graph by conversation`
		: t`Color graph by conversation`;
	const chit = (key: string, label: string, style: CSSProperties) => (
		<UnstyledButton
			key={key}
			onClick={onToggle}
			aria-pressed={active}
			data-selected={active || undefined}
			title={title}
			data-testid={`conversation-chit-${key}`}
			className={cn(CHIP_CLASS, ON_MARKER_CLASS)}
			style={{ ...style, ...pressableChipStyle(active) }}
		>
			{label}
		</UnstyledButton>
	);
	if (unique.length > NAMED_CHITS) {
		return chit(
			"many",
			plural(unique.length, {
				one: "# conversation",
				other: "# conversations",
			}),
			{ backgroundImage: blendBackground(conversationColors(slots)) },
		);
	}
	return (
		<>
			{unique.map((slot) =>
				chit(slotKey(slot), names?.get(slot) || conversationSlotLabel(slot), {
					backgroundColor: conversationColor(slot),
				}),
			)}
		</>
	);
};

/** The shared selected node: its type's details, chips and fact-checking. */
export const SpotlightPanel = memo(function SpotlightPanel({
	node,
	evidence,
	factCheck,
	colorBy,
	onColorByChange,
	canFactCheck,
	onFactCheck,
	onCancelFactCheck,
	conversationHref,
	conversationNames,
	locale,
	inspection = null,
	cluster = null,
	onSelectNode,
}: SpotlightPanelProps) {
	const type = node?.metadata.objectType ?? "argument";
	const eligible = node
		? isFactCheckEligible(attributeInputsOf(node.metadata))
		: false;
	const argumentType = FACT_CHECKABLE_TYPES.has(type);
	const valenceApplies = ATTRIBUTES.valence.appliesTo.includes(type);
	const valence = node?.metadata.valence;
	const verdict = eligible ? deriveDisplayVerdict(factCheck) : undefined;

	const valenceActive = colorBy === "valence";
	const verdictActive = colorBy === "factCheck";
	const conversationActive = colorBy === "conversation";

	const factCheckTag = verdict
		? {
				className: VERDICT_CHIP_CLASS[verdict],
				label: verdictLabel(verdict),
				style: undefined,
			}
		: argumentType
			? {
					className: OPINION_CHIP_CLASS,
					label: t`Opinion`,
					style: OPINION_CHIP_STYLE,
				}
			: undefined;

	const timestamp = formatTimestamp(node?.metadata.createdAt, locale);
	const status = factCheck?.status ?? "idle";

	return (
		<section
			id="spotlight-panel"
			className="flex h-full min-h-0 flex-col"
			aria-label={t`Spotlight`}
		>
			<PanelHeader title={<Trans>Spotlight</Trans>} dotClassName="bg-cyan" />

			{cluster ? (
				<ClusterSummary
					distillation={cluster.distillation}
					nodes={cluster.nodes}
					conversationNames={conversationNames}
					onSelectNode={(id) => onSelectNode?.(id)}
				/>
			) : node ? (
				<>
					{/* The statement and the colour chits stay put; what explains
					    them, the quotes and the rest scroll under them. */}
					<div className="space-y-2 pb-2">
						<p className="leading-snug" data-testid="spotlight-statement">
							{primaryText(
								type,
								resultFields({ detail: inspection?.object?.detail }),
								node.label ?? node.id,
							)}
						</p>
						<div className="flex flex-wrap gap-2">
							<ConversationChits
								slots={node.metadata.conversationSlots ?? []}
								names={conversationNames}
								active={conversationActive}
								onToggle={() =>
									onColorByChange(conversationActive ? "none" : "conversation")
								}
							/>
							{valenceApplies && (
								<UnstyledButton
									onClick={() =>
										onColorByChange(valenceActive ? "none" : "valence")
									}
									aria-pressed={valenceActive}
									data-selected={valenceActive || undefined}
									title={
										valenceActive
											? t`Stop coloring graph by valence`
											: t`Color graph by valence`
									}
									className={cn(CHIP_CLASS, valenceChipClass(valence))}
									style={{
										...valenceChipStyle(valence),
										...pressableChipStyle(valenceActive),
									}}
								>
									{valenceLabel(valence)}
								</UnstyledButton>
							)}
							{factCheckTag && (
								<UnstyledButton
									onClick={() =>
										onColorByChange(verdictActive ? "none" : "factCheck")
									}
									aria-pressed={verdictActive}
									data-selected={verdictActive || undefined}
									title={
										verdictActive
											? t`Stop coloring graph by factual status`
											: t`Color graph by factual status`
									}
									className={cn(CHIP_CLASS, factCheckTag.className)}
									style={{
										...factCheckTag.style,
										...pressableChipStyle(verdictActive),
									}}
								>
									{factCheckTag.label}
								</UnstyledButton>
							)}
						</div>
					</div>

					<div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
						{valenceActive && valenceApplies && (
							<p className="text-xs">{valenceBlurb(valence)}</p>
						)}

						{verdictActive && (
							<div className="space-y-2">
								{!eligible && argumentType && (
									<p className="text-xs">
										<Trans>
											Arguments express stances or preferences and aren't
											fact-checked.
										</Trans>
									</p>
								)}

								{!eligible && !argumentType && (
									<p className="text-xs">
										<Trans>Factual status does not apply to this object.</Trans>
									</p>
								)}

								{eligible && status === "idle" && canFactCheck && (
									<Button
										size="compact-sm"
										fullWidth
										onClick={() => onFactCheck(node.id)}
									>
										<Trans>Fact-check this claim</Trans>
									</Button>
								)}

								{eligible && status === "idle" && !canFactCheck && (
									<CaptionText>
										<Trans>This claim has not been fact-checked.</Trans>
									</CaptionText>
								)}

								{eligible && status === "processing" && (
									<div className="flex items-center justify-between gap-2 text-xs">
										<div className="flex items-center gap-2">
											<span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
											<Trans>Checking…</Trans>
										</div>
										{canFactCheck && (
											<Button
												size="compact-xs"
												variant="subtle"
												color="gray"
												onClick={() => onCancelFactCheck(node.id)}
											>
												<Trans>Cancel</Trans>
											</Button>
										)}
									</div>
								)}

								{eligible && factCheck?.status === "done" && (
									<div className="space-y-2">
										<p className="text-xs">{factCheck.justification}</p>
										{factCheck.sources.length > 0 && (
											<p className="text-xs leading-relaxed">
												{factCheck.sources.map((source, index) => (
													<span key={source.url}>
														<Anchor
															href={source.url}
															target="_blank"
															rel="noopener noreferrer"
															size="xs"
														>
															{source.title}
														</Anchor>
														{index < factCheck.sources.length - 1 && ", "}
													</span>
												))}
											</p>
										)}
										{canFactCheck && (
											<Button
												size="compact-xs"
												variant="subtle"
												onClick={() => onFactCheck(node.id, { force: true })}
											>
												<Trans>Re-check</Trans>
											</Button>
										)}
									</div>
								)}

								{eligible && factCheck?.status === "error" && (
									<div className="space-y-2">
										<p
											className="text-xs"
											style={{ color: "var(--map-error)" }}
										>
											{factCheck.message}
										</p>
										{canFactCheck && (
											<Button
												size="compact-xs"
												onClick={() => onFactCheck(node.id)}
											>
												<Trans>Try again</Trans>
											</Button>
										)}
									</div>
								)}
							</div>
						)}

						<NodeDetailCard
							node={node}
							evidence={evidence}
							conversationHref={conversationHref}
							collapsibleQuotes
							statement={false}
							inspection={inspection}
						/>

						{timestamp ? <p className="text-xs">{timestamp}</p> : null}
					</div>
				</>
			) : (
				<CaptionText>
					<Trans>
						Click a node in the tree or cluster map to spotlight it here.
					</Trans>
				</CaptionText>
			)}
		</section>
	);
});
