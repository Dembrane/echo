import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Pagination,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { EntityListRow } from "@/components/common/EntityListRow";
import type { AnalysisObject } from "./hooks";

export type AnalysisResultsListProps = {
	counts: Record<string, number>;
	items: AnalysisObject[];
	labels: Record<string, string>;
	limit: number;
	onInspect: (item: AnalysisObject) => void;
	onPageChange: (page: number) => void;
	page: number;
	total: number;
};

export function AnalysisResultsList({
	counts,
	items,
	labels,
	limit,
	onInspect,
	onPageChange,
	page,
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
					return (
						<EntityListRow
							key={item.revisionId}
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

										<Tooltip label={t`Inspect evidence`}>
											<ActionIcon
												variant="subtle"
												color="primary"
												aria-label={t`Inspect evidence`}
												onClick={(event) => {
													event.stopPropagation();
													onInspect(item);
												}}
											>
												<IconExternalLink size={16} />
											</ActionIcon>
										</Tooltip>
									</Group>

									{item.missing && (
										<Text size="sm">
											<Trans>This revision is unavailable.</Trans>
										</Text>
									)}
								</Stack>
							</Group>
						</EntityListRow>
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
