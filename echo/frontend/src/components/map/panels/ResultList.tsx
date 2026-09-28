import { t } from "@lingui/core/macro";
import { UnstyledButton } from "@mantine/core";
import { memo } from "react";
import { OBJECT_TYPE_STYLES, OBJECT_TYPES } from "../attributes";
import {
	useMapInteraction,
	useMapInteractionStore,
} from "../state/interactionStore";
import type { MapGraphNode } from "../types";
import { CaptionText, mapVars, TypeDot } from "./shared";

type ResultListProps = {
	/** Every visible object, placed or not. */
	nodes: ReadonlyArray<MapGraphNode>;
	/** Objects without a usable vector. */
	unplacedIds: ReadonlySet<string>;
};

/**
 * The objects as a plain list, grouped by type. It is the primary entry for
 * small results and keeps oversized scopes inspectable without a layout.
 * Selecting an item selects the node, as a click on the map does.
 */
export const ResultList = memo(function ResultList({
	nodes,
	unplacedIds,
}: ResultListProps) {
	const store = useMapInteractionStore();
	const selectedNodeId = useMapInteraction((state) => state.selectedNodeId);

	const groups = OBJECT_TYPES.map((type) => ({
		items: nodes.filter((node) => node.metadata.objectType === type),
		type,
	})).filter((group) => group.items.length > 0);

	return (
		<section
			id="result-list"
			className="flex h-full min-h-0 flex-col overflow-y-auto pr-1"
			aria-label={t`Results`}
		>
			{groups.map((group) => (
				<div key={group.type} className="mb-4">
					<div
						className="mb-2 flex items-center justify-between border-b pb-1"
						style={{ borderColor: mapVars.border }}
					>
						<h3 className="flex items-center gap-2 text-xs font-light uppercase tracking-wider">
							<TypeDot type={group.type} />
							{OBJECT_TYPE_STYLES[group.type].pluralLabel()}
						</h3>
						<span className="text-xs">{group.items.length}</span>
					</div>
					<ul className="space-y-1">
						{group.items.map((node) => {
							const selected = node.id === selectedNodeId;
							return (
								<li key={node.id}>
									<UnstyledButton
										onClick={() =>
											store.setSelectedNodeId(selected ? null : node.id)
										}
										aria-pressed={selected}
										className="block w-full rounded p-2 text-left transition-opacity hover:opacity-80"
										style={{
											backgroundColor: selected
												? mapVars.accentSurface
												: mapVars.card,
										}}
									>
										<span className="text-sm leading-snug">
											{node.label || node.id}
										</span>
										{unplacedIds.has(node.id) && (
											<CaptionText>{t`Not placed on the map`}</CaptionText>
										)}
									</UnstyledButton>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</section>
	);
});
