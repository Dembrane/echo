import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { EvidenceGroup } from "../data/adapter";
import { deriveDisplayVerdict } from "../graph/nodeStyle";
import type { FactCheckState, MapGraphNode } from "../types";
import { CountdownProgressBar } from "./CountdownProgressBar";
import { type ConversationHref, NodeDetailCard } from "./NodeDetailCard";
import {
	CaptionText,
	formatTimestamp,
	mapVars,
	PanelHeader,
	VALENCE_CHIP_CLASS,
	VERDICT_CHIP_CLASS,
	valenceLabel,
	verdictLabel,
} from "./shared";

type ShowcasePanelProps = {
	/** The random walk's current node. */
	node: MapGraphNode | null;
	evidence: EvidenceGroup[];
	factCheck: FactCheckState | undefined;
	expiresAt: number | null;
	durationMs: number;
	conversationHref?: ConversationHref;
	locale?: string;
};

const STATIC_CHIP =
	"inline-block rounded-none px-2 py-0.5 text-xs font-semibold uppercase tracking-wider";

/** The random walk in large type, with a countdown to the next step. */
export const ShowcasePanel = memo(function ShowcasePanel({
	node,
	evidence,
	factCheck,
	expiresAt,
	durationMs,
	conversationHref,
	locale,
}: ShowcasePanelProps) {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const interval = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(interval);
	}, []);

	const hasTimer = Boolean(expiresAt && durationMs > 0);
	const remainingMs = hasTimer && expiresAt ? Math.max(0, expiresAt - now) : 0;
	const remainingSeconds = Math.ceil(remainingMs / 1000);
	const progressKey = hasTimer
		? String(expiresAt)
		: `idle-${node?.id ?? "none"}`;

	const valence = node ? (node.metadata.valence ?? "neutral") : undefined;
	const verdict =
		node?.metadata.kind === "claim"
			? deriveDisplayVerdict(factCheck)
			: undefined;
	const timestamp = formatTimestamp(node?.metadata.createdAt, locale);

	return (
		<section
			id="showcase-panel"
			className="flex h-full min-h-0 flex-col justify-between gap-4"
			aria-label={t`Showcase`}
		>
			<div className="min-h-0 flex-1 overflow-y-auto pr-1">
				<PanelHeader title={<Trans>Showcase</Trans>} dotClassName="bg-cyan" />

				{node ? (
					<div className="space-y-3">
						<NodeDetailCard
							node={node}
							evidence={evidence}
							conversationHref={conversationHref}
							titleSize="large"
						/>

						<div className="flex flex-wrap gap-2">
							{valence && (
								<span className={cn(STATIC_CHIP, VALENCE_CHIP_CLASS[valence])}>
									{valenceLabel(valence)}
								</span>
							)}
							{verdict && (
								<span className={cn(STATIC_CHIP, VERDICT_CHIP_CLASS[verdict])}>
									{verdictLabel(verdict)}
								</span>
							)}
						</div>

						{timestamp ? (
							<p className="text-xs uppercase tracking-widest">{timestamp}</p>
						) : null}
					</div>
				) : (
					<CaptionText>
						<Trans>
							The random walk will surface nodes here once available.
						</Trans>
					</CaptionText>
				)}
			</div>

			<div id="showcase-progress">
				<div
					className="mb-2 h-2 w-full overflow-hidden"
					style={{ backgroundColor: mapVars.card }}
				>
					<CountdownProgressBar
						key={progressKey}
						durationMs={durationMs}
						remainingMs={remainingMs}
						isActive={hasTimer}
						className="bg-cyan"
					/>
				</div>
				<p className="text-xs uppercase tracking-widest">
					{hasTimer ? (
						<Trans>
							Next change in{" "}
							<span className="font-semibold">{remainingSeconds}s</span>
						</Trans>
					) : (
						<Trans>Waiting for the next node</Trans>
					)}
				</p>
			</div>
		</section>
	);
});
