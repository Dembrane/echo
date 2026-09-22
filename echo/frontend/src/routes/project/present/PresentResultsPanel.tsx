import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	CloseButton,
	Group,
	Pagination,
	Stack,
	Text,
} from "@mantine/core";
import { useState } from "react";
import { useSearchParams } from "react-router";
import {
	type AnalysisObject,
	EvidenceInspectionDrawer,
	useAnalysisObjects,
} from "@/components/analysis";
import { ResultRowActions } from "@/components/analysis/ResultRowActions";
import { usePopcornSettingsMutation } from "@/components/popcorn/hooks";
import {
	ALWAYS_ON_BLOCK,
	orderedBlocks,
	type PresentationBlock,
} from "@/components/present/blocks";
import type { Presentation } from "@/components/present/hooks";
import { testId } from "@/lib/testUtils";
import { blockLabel } from "./blockLabel";
import classes from "./PresentResultsPanel.module.css";

// Which tab a kind of result lands on.
const BLOCK_BY_TYPE: Record<string, PresentationBlock> = {
	argument: "map",
	deduplicated_argument: "map",
	popcorn: "popcorn",
	stakeholder: "stakeholders",
	tension: "tensions",
};

/**
 * The results the room will see, for the host to reword, check or hide. A
 * sibling of the presentation editor, not a part of it: that one is the style
 * and structure of the screen, this one is what the screen says. It saves
 * through whatever `SettingsSaveContext` it sits in, which on the Present page
 * is the presentation's draft, so a hidden finding waits for Publish like any
 * other change.
 */
export function PresentResultsPanel({
	projectId,
	presentation,
	onClose,
	className,
}: {
	projectId: string;
	presentation: Presentation;
	onClose: () => void;
	className?: string;
}) {
	const [params, setParams] = useSearchParams();
	const resultPage = Math.max(0, Number(params.get("resultsPage")) || 0);
	const results = useAnalysisObjects(
		projectId,
		undefined,
		"active",
		resultPage * 100,
	);
	const [inspected, setInspected] = useState<AnalysisObject | null>(null);
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	const hidden = presentation.settings.presentation?.hidden_items ?? [];
	const selected = orderedBlocks([
		...(presentation.settings.presentation?.blocks ?? []),
		ALWAYS_ON_BLOCK,
	]);
	return (
		<Stack
			component="section"
			aria-label={t`Review results`}
			className={className}
			gap="sm"
			{...testId("present-results-panel")}
		>
			<Group justify="space-between" wrap="nowrap">
				<Text fw={500}>
					<Trans>Review results</Trans>
				</Text>
				<CloseButton aria-label={t`Close results review`} onClick={onClose} />
			</Group>
			<Text size="sm">
				<Trans>
					Edit the wording, check the evidence, or hide a finding from this
					presentation. Shared results stay available in Analysis.
				</Trans>
			</Text>
			{results.isError && (
				<Text>
					<Trans>Results could not be loaded.</Trans>
				</Text>
			)}
			<Stack gap={0}>
				{results.data?.items
					.filter((item) => selected.includes(BLOCK_BY_TYPE[item.type]))
					.map((item) => {
						const away = hidden.includes(item.objectId);
						const label = item.label ?? item.objectId;
						const block = BLOCK_BY_TYPE[item.type];
						return (
							<Group
								key={item.objectId}
								className={`${classes.row} ${away ? classes.rowHidden : ""}`}
								gap="sm"
								justify="space-between"
								wrap="nowrap"
								{...testId(`present-result-${item.objectId}`)}
							>
								<Group gap="xs" wrap="nowrap" className={classes.rowLabel}>
									<Text size="sm" truncate title={label}>
										{label}
									</Text>
									{block && (
										<Badge
											size="xs"
											variant="outline"
											style={{ flexShrink: 0 }}
										>
											{blockLabel(block)}
										</Badge>
									)}
								</Group>
								<ResultRowActions
									hidden={away}
									onEdit={() => setInspected(item)}
									onToggleHidden={() =>
										save.mutate({
											presentation: {
												hidden_items: away
													? hidden.filter((id) => id !== item.objectId)
													: [...hidden, item.objectId],
											},
										})
									}
									testIdPrefix={`present-result-${item.objectId}`}
								/>
							</Group>
						);
					})}
			</Stack>
			{/* One footer across the panel's width: the way back on the left, the
			    pager on the right. */}
			<Group justify="space-between" gap="sm">
				{hidden.length ? (
					<Button
						variant="subtle"
						size="compact-sm"
						onClick={() =>
							save.mutate({
								presentation: { hidden_items: [] },
							})
						}
					>
						<Trans>Reset hidden findings ({hidden.length})</Trans>
					</Button>
				) : (
					<span />
				)}
				{results.data && results.data.total > results.data.limit && (
					<Pagination
						size="sm"
						value={resultPage + 1}
						total={Math.max(
							1,
							Math.ceil(results.data.total / results.data.limit),
						)}
						onChange={(page) =>
							setParams((previous) => {
								const next = new URLSearchParams(previous);
								next.set("resultsPage", String(page - 1));
								return next;
							})
						}
					/>
				)}
			</Group>
			<EvidenceInspectionDrawer
				projectId={projectId}
				snapshotId={results.data?.snapshotId}
				item={inspected}
				opened={!!inspected}
				onClose={() => setInspected(null)}
			/>
		</Stack>
	);
}
