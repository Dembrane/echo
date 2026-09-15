import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Button, UnstyledButton } from "@mantine/core";
import { memo } from "react";
import { cn } from "@/lib/utils";
import type { EvidenceGroup } from "../data/adapter";
import { deriveDisplayVerdict } from "../graph/nodeStyle";
import type { ColorBy, FactCheckState, MapGraphNode } from "../types";
import { type ConversationHref, NodeDetailCard } from "./NodeDetailCard";
import {
	CaptionText,
	CHIP_CLASS,
	formatTimestamp,
	OPINION_CHIP_CLASS,
	PanelHeader,
	VALENCE_CHIP_CLASS,
	VERDICT_CHIP_CLASS,
	valenceBlurb,
	valenceLabel,
	verdictLabel,
} from "./shared";

type SpotlightPanelProps = {
	node: MapGraphNode | null;
	evidence: EvidenceGroup[];
	/** The claim's current state; undefined for arguments. */
	factCheck: FactCheckState | undefined;
	colorBy: ColorBy;
	onColorByChange: (colorBy: ColorBy) => void;
	/** False for read-only roles: verdicts show, controls do not. */
	canFactCheck: boolean;
	onFactCheck: (nodeId: string, options?: { force?: boolean }) => void;
	onCancelFactCheck: (nodeId: string) => void;
	conversationHref?: ConversationHref;
	locale?: string;
};

const ACTIVE_RING = "ring-2 ring-offset-1 ring-gray-400";

/** The shared selected node: statement, evidence, chips and fact-checking. */
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
	locale,
}: SpotlightPanelProps) {
	const isClaim = node?.metadata.kind === "claim";
	const isArgument = node?.metadata.kind === "argument";
	const valence = node ? (node.metadata.valence ?? "neutral") : undefined;
	const verdict = isClaim ? deriveDisplayVerdict(factCheck) : undefined;

	const valenceActive = colorBy === "valence";
	const verdictActive = colorBy === "factCheck";

	const factCheckTag = isArgument
		? { className: OPINION_CHIP_CLASS, label: t`Opinion` }
		: verdict
			? { className: VERDICT_CHIP_CLASS[verdict], label: verdictLabel(verdict) }
			: undefined;

	const timestamp = formatTimestamp(node?.metadata.createdAt, locale);
	const status = factCheck?.status ?? "idle";

	return (
		<section
			id="spotlight-panel"
			className="flex h-full min-h-0 flex-col"
			aria-label={t`Spotlight`}
		>
			<div className="min-h-0 flex-1 overflow-y-auto pr-1">
				<PanelHeader title={<Trans>Spotlight</Trans>} dotClassName="bg-cyan" />

				{node ? (
					<div className="space-y-2">
						<NodeDetailCard
							node={node}
							evidence={evidence}
							conversationHref={conversationHref}
							titleSize="small"
							collapsibleQuotes
						/>

						{(valence || factCheckTag) && (
							<div className="flex flex-wrap gap-1.5">
								{valence && (
									<UnstyledButton
										onClick={() =>
											onColorByChange(valenceActive ? "none" : "valence")
										}
										aria-pressed={valenceActive}
										title={
											valenceActive
												? t`Stop coloring graph by valence`
												: t`Color graph by valence`
										}
										className={cn(
											CHIP_CLASS,
											"transition-opacity hover:opacity-80",
											VALENCE_CHIP_CLASS[valence],
											valenceActive && ACTIVE_RING,
										)}
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
										title={
											verdictActive
												? t`Stop coloring graph by fact-check`
												: t`Color graph by fact-check`
										}
										className={cn(
											CHIP_CLASS,
											"transition-opacity hover:opacity-80",
											factCheckTag.className,
											verdictActive && ACTIVE_RING,
										)}
									>
										{factCheckTag.label}
									</UnstyledButton>
								)}
							</div>
						)}

						{valenceActive && valence && (
							<p className="text-xs">{valenceBlurb(valence)}</p>
						)}

						{verdictActive && (
							<div className="space-y-2">
								{isArgument && (
									<p className="text-xs">
										<Trans>
											Arguments express stances or preferences and aren't
											fact-checked.
										</Trans>
									</p>
								)}

								{isClaim && status === "idle" && canFactCheck && (
									<Button
										size="compact-sm"
										radius="xl"
										fullWidth
										onClick={() => onFactCheck(node.id)}
									>
										<Trans>Fact check this claim</Trans>
									</Button>
								)}

								{isClaim && status === "idle" && !canFactCheck && (
									<CaptionText>
										<Trans>This claim has not been fact-checked.</Trans>
									</CaptionText>
								)}

								{isClaim && status === "processing" && (
									<div className="flex items-center justify-between gap-2 text-xs">
										<div className="flex items-center gap-2">
											<span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
											<Trans>Checking…</Trans>
										</div>
										{canFactCheck && (
											<Button
												size="compact-xs"
												variant="subtle"
												radius="xl"
												onClick={() => onCancelFactCheck(node.id)}
											>
												<Trans>Cancel</Trans>
											</Button>
										)}
									</div>
								)}

								{isClaim && factCheck?.status === "done" && (
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

								{isClaim && factCheck?.status === "error" && (
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
												variant="outline"
												radius="xl"
												onClick={() => onFactCheck(node.id)}
											>
												<Trans>Retry</Trans>
											</Button>
										)}
									</div>
								)}
							</div>
						)}

						{timestamp ? (
							<p className="text-xs uppercase tracking-widest">{timestamp}</p>
						) : null}
					</div>
				) : (
					<CaptionText>
						<Trans>
							Click a node in the tree or cluster map to spotlight it here.
						</Trans>
					</CaptionText>
				)}
			</div>
		</section>
	);
});
