import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Loader, UnstyledButton } from "@mantine/core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import type {
	Distillation,
	SelectionTitleError,
} from "../hooks/useSelectionTitle";
import type { MapGraphNode } from "../types";
import { CaptionText, mapVars, PanelHeader } from "./shared";

type ExplorePanelProps = {
	isProcessing: boolean;
	error: SelectionTitleError | null;
	onRetry: () => void;
	history: Distillation[];
	/** Nodes on the current map, by id. */
	nodesById: ReadonlyMap<string, MapGraphNode>;
	selectedDistillationId: string | null;
	onSelectDistillation: (id: string) => void;
};

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

const NodeListAccordion = ({ nodes }: { nodes: MapGraphNode[] }) => {
	const [open, setOpen] = useState(false);
	return (
		<div className="space-y-1.5">
			<UnstyledButton
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs uppercase tracking-wider transition-opacity hover:opacity-80"
				style={{ color: mapVars.accentText }}
			>
				<CaretRightIcon
					size={12}
					className={cn("transition-transform", open && "rotate-90")}
				/>
				<Trans>Contributing nodes ({nodes.length})</Trans>
			</UnstyledButton>
			{open && (
				<ul className="space-y-0.5 pl-4">
					{nodes.map((node) => (
						<li key={node.id} className="text-xs leading-snug">
							• {node.label ?? node.id}
						</li>
					))}
				</ul>
			)}
		</div>
	);
};

/** Selection titles: the pending one, a failure, and the session's history. */
export const ExplorePanel = memo(function ExplorePanel({
	isProcessing,
	error,
	onRetry,
	history,
	nodesById,
	selectedDistillationId,
	onSelectDistillation,
}: ExplorePanelProps) {
	return (
		<section
			id="explore-panel"
			className="flex h-full min-h-0 flex-col justify-between gap-3"
			aria-label={t`Explore`}
		>
			<div className="min-h-0 flex-1 overflow-y-auto pr-1">
				<PanelHeader title={<Trans>Explore</Trans>} dotClassName="bg-primary" />

				{isProcessing && (
					<div
						className="mb-3 flex items-center gap-2 p-2"
						style={{ backgroundColor: mapVars.card }}
					>
						<Loader size={16} color="primary" />
						<span className="text-xs">
							<Trans>Distilling core idea...</Trans>
						</span>
					</div>
				)}

				{error && !isProcessing && (
					<div
						className="mb-3 flex items-center justify-between gap-2 p-2"
						style={{ backgroundColor: mapVars.card }}
						role="alert"
					>
						<span className="text-xs">
							{error.kind === "too-large" ? (
								<Trans>This selection is too large to title.</Trans>
							) : (
								<Trans>The title could not be generated.</Trans>
							)}
						</span>
						{error.kind === "failed" && (
							<Button
								size="compact-xs"
								variant="subtle"
								radius={0}
								onClick={onRetry}
							>
								<Trans>Retry</Trans>
							</Button>
						)}
					</div>
				)}

				{history.length > 0 ? (
					<div className="space-y-2">
						{history.map((distillation) => {
							const isSelected = distillation.id === selectedDistillationId;
							return (
								<div
									key={distillation.id}
									className="border transition-colors"
									style={{
										backgroundColor: isSelected
											? mapVars.accentSurface
											: mapVars.card,
										borderColor: isSelected
											? mapVars.accentBorder
											: "transparent",
									}}
								>
									<UnstyledButton
										onClick={() => onSelectDistillation(distillation.id)}
										aria-pressed={isSelected}
										className="block w-full p-3 text-left transition-opacity hover:opacity-80"
									>
										<span
											className="block text-sm font-medium leading-tight"
											style={{
												color: isSelected ? mapVars.accentText : undefined,
											}}
										>
											{distillation.title}
										</span>
									</UnstyledButton>

									{isSelected && (
										<div
											className="mx-3 mb-3 border-t pt-2"
											style={{ borderColor: mapVars.accentBorder }}
										>
											<NodeListAccordion
												nodes={resolveNodes(distillation.nodeIds, nodesById)}
											/>
										</div>
									)}
								</div>
							);
						})}
					</div>
				) : (
					!isProcessing &&
					!error && (
						<CaptionText>
							<Trans>
								Hover over nodes to explore clusters. Hold position for 1.5s to
								distill the core idea.
							</Trans>
						</CaptionText>
					)
				)}
			</div>
		</section>
	);
});
