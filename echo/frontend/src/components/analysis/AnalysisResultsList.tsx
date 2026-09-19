import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, Pagination, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { EntityListRow } from "@/components/common/EntityListRow";
import type { AnalysisObject } from "./hooks";
import { ResultRowActions } from "./ResultRowActions";

export type AnalysisResultsListProps = {
	counts: Record<string, number>;
	items: AnalysisObject[];
	labels: Record<string, string>;
	limit: number;
	onInspect: (item: AnalysisObject) => void;
	onPageChange: (page: number) => void;
	page: number;
	total: number;
	/** The row that is open. Its item is drawn under it, inside the list. */
	expandedObjectId?: string | null;
	renderExpanded?: (item: AnalysisObject) => ReactNode;
};

export function AnalysisResultsList({
	counts,
	expandedObjectId,
	items,
	labels,
	limit,
	onInspect,
	onPageChange,
	page,
	renderExpanded,
	total,
}: AnalysisResultsListProps) {
	const pages = Math.max(1, Math.ceil(total / limit));

	return (
		<Stack gap="md">
			<Group gap="xs">
				{Object.entries(counts).map(([key, count]) => (
					<Badge key={key} variant="outline">
						{labels[key] ?? key}: {count}
					</Badge>
				))}
			</Group>

			<Stack gap="sm">
				{items.map((item) => {
					const label = item.label ?? item.objectId;
					const open = expandedObjectId === item.objectId;
					return (
						<Stack gap="sm" key={item.revisionId}>
							<EntityListRow
								ariaLabel={t`Inspect evidence for ${label}`}
								onActivate={() => onInspect(item)}
								testId={`analysis-result-row-${item.objectId}`}
							>
								<Group align="flex-start" gap="md" wrap="nowrap">
									<Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
										<Group
											justify="space-between"
											align="flex-start"
											wrap="nowrap"
										>
											<Stack gap={2} style={{ minWidth: 0 }}>
												<Text size="sm" fw={500} lineClamp={2}>
													{label}
												</Text>
												<Group gap="xs" wrap="wrap">
													<Badge size="xs" variant="outline">
														{labels[item.type] ?? item.type}
													</Badge>
													{item.membershipExcluded && (
														<Badge size="xs" color="red" variant="outline">
															<Trans>Withdrawn</Trans>
														</Badge>
													)}
												</Group>
											</Stack>

											{/* The same gestures in the same place as every other
									    table of findings. */}
											{/* biome-ignore lint/a11y/noStaticElementInteractions: only keeps a click on an icon from also opening the row */}
											{/* biome-ignore lint/a11y/useKeyWithClickEvents: the icons inside are the keyboard targets */}
											<div onClick={(event) => event.stopPropagation()}>
												<ResultRowActions
													onEdit={() => onInspect(item)}
													testIdPrefix={`analysis-result-${item.objectId}`}
												/>
											</div>
										</Group>

										{item.missing && (
											<Text size="sm">
												<Trans>This revision is unavailable.</Trans>
											</Text>
										)}
									</Stack>
								</Group>
							</EntityListRow>
							{/* The item opens inside the list, under its own row. */}
							{open && renderExpanded?.(item)}
						</Stack>
					);
				})}
			</Stack>

			{pages > 1 && (
				<Group justify="center">
					<Pagination value={page} total={pages} onChange={onPageChange} />
				</Group>
			)}
		</Stack>
	);
}
