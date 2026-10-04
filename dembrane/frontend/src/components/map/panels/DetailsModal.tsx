import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Modal, UnstyledButton } from "@mantine/core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { EvidenceGroup } from "../data/adapter";
import type { Distillation } from "../hooks/useMapGroups";
import type { ColorBy, Edge, MapGraphNode, MapRelation } from "../types";
import { LocalGraph } from "./LocalGraph";
import {
	type ConversationHref,
	NodeDetailCard,
	type NodeInspection,
	QuoteGroups,
} from "./NodeDetailCard";
import { CaptionText } from "./shared";

export type DetailsTarget =
	| { kind: "argument"; node: MapGraphNode; inspection: NodeInspection | null }
	| { kind: "cluster"; distillation: Distillation; nodes: MapGraphNode[] };

/** One of a cluster's arguments, its quotes folded under it. */
const ArgumentBranch = ({
	node,
	evidence,
	conversationHref,
	onSelect,
	open: startOpen,
}: {
	node: MapGraphNode;
	evidence: EvidenceGroup[];
	conversationHref?: ConversationHref;
	onSelect: (nodeId: string) => void;
	open: boolean;
}) => {
	const [open, setOpen] = useState(startOpen);
	const quotes = evidence.reduce(
		(total, group) => total + group.quotes.length,
		0,
	);
	return (
		<li className="space-y-2">
			<div className="flex items-start gap-1">
				<UnstyledButton
					onClick={() => setOpen((value) => !value)}
					aria-expanded={open}
					aria-label={t`Quotes (${quotes})`}
					disabled={quotes === 0}
					className="mt-0.5"
				>
					<CaretRightIcon
						size={16}
						className={cn(
							"transition-transform",
							open && "rotate-90",
							quotes === 0 && "opacity-0",
						)}
					/>
				</UnstyledButton>
				<UnstyledButton
					onClick={() => onSelect(node.id)}
					className="text-left text-sm leading-snug transition-opacity hover:opacity-80"
				>
					{node.label ?? node.id}
				</UnstyledButton>
			</div>
			{open && quotes > 0 && (
				<div className="pl-5">
					<QuoteGroups
						evidence={evidence}
						conversationHref={conversationHref}
					/>
				</div>
			)}
		</li>
	);
};

/**
 * Details on demand for the spotlit item: its arguments and quotes as a tree
 * beside a drawing of what it connects to. Choosing anything in either makes
 * that the spotlight.
 */
export const DetailsModal = ({
	target,
	opened,
	onClose,
	quotesOpen,
	evidenceFor,
	conversationHref,
	nodesById,
	edges,
	relations,
	colorBy,
	darkMode,
	onSelect,
}: {
	target: DetailsTarget | null;
	opened: boolean;
	onClose: () => void;
	/** True when opened from Quotes: every quote starts unfolded. */
	quotesOpen: boolean;
	evidenceFor: (nodeId: string) => EvidenceGroup[];
	conversationHref?: ConversationHref;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	edges: ReadonlyArray<Edge>;
	relations: ReadonlyArray<MapRelation>;
	colorBy: ColorBy;
	darkMode: boolean;
	onSelect: (nodeId: string) => void;
}) => {
	if (!target) return null;
	const select = (nodeId: string) => {
		onClose();
		onSelect(nodeId);
	};
	const title =
		target.kind === "argument"
			? (target.node.label ?? target.node.id)
			: (target.distillation.title ?? t`Distilling core idea…`);
	const focusIds =
		target.kind === "argument"
			? [target.node.id]
			: target.nodes.map((node) => node.id);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			size="xl"
			title={title}
			// Inside the map, so it keeps the map's own colours in both themes.
			withinPortal={false}
		>
			<div className="grid gap-6 md:grid-cols-2" data-testid="details-modal">
				<section className="min-w-0 space-y-3" aria-label={t`Tree`}>
					{target.kind === "argument" ? (
						<NodeDetailCard
							node={target.node}
							evidence={evidenceFor(target.node.id)}
							conversationHref={conversationHref}
							statement={false}
							inspection={target.inspection}
						/>
					) : (
						<>
							<CaptionText>
								{plural(target.nodes.length, {
									one: "# argument",
									other: "# arguments",
								})}
							</CaptionText>
							<ol className="space-y-3">
								{target.nodes.map((node) => (
									<ArgumentBranch
										key={node.id}
										node={node}
										evidence={evidenceFor(node.id)}
										conversationHref={conversationHref}
										onSelect={select}
										open={quotesOpen}
									/>
								))}
							</ol>
						</>
					)}
				</section>
				<section className="min-w-0 space-y-2" aria-label={t`Connections`}>
					<CaptionText>
						{target.kind === "argument" ? (
							<Trans>Its neighbours in the tree, and its relationships</Trans>
						) : (
							<Trans>Its arguments, and the tree between them</Trans>
						)}
					</CaptionText>
					<LocalGraph
						focusIds={focusIds}
						expand={target.kind === "argument"}
						nodesById={nodesById}
						edges={edges}
						relations={relations}
						colorBy={colorBy}
						darkMode={darkMode}
						onSelect={select}
					/>
				</section>
			</div>
		</Modal>
	);
};
