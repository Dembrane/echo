import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CloseButton, Group, Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
	type AnalysisObject,
	useResultsList,
	useResultsVisit,
} from "@/components/analysis";
import { usePopcornSettingsMutation } from "@/components/popcorn/hooks";
import {
	ALWAYS_ON_BLOCK,
	orderedBlocks,
	type PresentationBlock,
} from "@/components/present/blocks";
import type { Presentation } from "@/components/present/hooks";
import {
	type HoldBackAdapter,
	type ResultGroupKey,
	ResultItem,
	ResultsList,
	useResultActions,
} from "@/components/results";
import { testId } from "@/lib/testUtils";

// Which group of the list a block draws its findings from.
const GROUP_BY_BLOCK: Record<PresentationBlock, ResultGroupKey> = {
	map: "argument",
	popcorn: "popcorn",
	stakeholders: "stakeholder",
	tensions: "tension",
};

/**
 * The results the room will see, for the host to reword, hold back or read in
 * full. A sibling of the presentation editor, not a part of it: that one is
 * the style and structure of the screen, this one is what the screen says.
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
	const { workspaceId } = useParams<{ workspaceId?: string }>();
	// One page of findings per kind, opened in place. There is no pager: a long
	// group says "Show all" where it stands and asks for what it still needs.
	const results = useResultsList(projectId);
	// What is new is new since the host last opened this list; leaving it marks
	// it seen.
	useResultsVisit(projectId);
	const [inspected, setInspected] = useState<AnalysisObject | null>(null);
	// The way to the full picture of a finding, kept so the host can come back.
	const analysisPath = `${workspaceId ? `/w/${workspaceId}` : ""}/projects/${projectId}/analysis?returnTo=present&section=results`;
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	const hidden = useMemo(
		() => presentation.settings.presentation?.hidden_items ?? [],
		[presentation.settings.presentation?.hidden_items],
	);
	const blocks = orderedBlocks([
		...(presentation.settings.presentation?.blocks ?? []),
		ALWAYS_ON_BLOCK,
	]);

	/**
	 * Step 5 replaces this adapter and nothing else on this screen.
	 *
	 * Today holding a finding back writes its id into the presentation draft's
	 * `hidden_items`, which keeps no reason, so the reason the host gives is
	 * collected by the prompt and dropped here. When the curation log endpoint
	 * exists, this becomes a post of `{ object_id, action, reason }` and the
	 * prompt, the suggestions and the dimmed row stay exactly as they are.
	 */
	const holdBack: HoldBackAdapter = useMemo(
		() => ({
			isHeld: (objectId) => hidden.includes(objectId),
			setHeld: (objectId, held, _reason) =>
				save.mutate({
					presentation: {
						hidden_items: held
							? [...hidden, objectId]
							: hidden.filter((id) => id !== objectId),
					},
				}),
		}),
		[hidden, save.mutate],
	);
	const actions = useResultActions({ holdBack, projectId });

	const groupOrder = blocks.map((block) => GROUP_BY_BLOCK[block]);
	// A kind whose block is off still has a header, and says so in words.
	const groupsOff = (Object.keys(GROUP_BY_BLOCK) as PresentationBlock[])
		.filter((block) => !blocks.includes(block))
		.map((block) => GROUP_BY_BLOCK[block]);

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
					Change the wording, read the evidence, or keep a finding out of this
					presentation. Shared results stay available in Analysis.
				</Trans>
			</Text>
			<ResultsList
				actions={actions}
				canEdit={results.canEdit}
				counts={results.counts}
				density="curate"
				error={
					results.isError ? (
						<Text>
							<Trans>Results could not be loaded.</Trans>
						</Text>
					) : null
				}
				groupOrder={[...groupOrder, ...groupsOff]}
				groupsOff={groupsOff}
				items={results.items}
				loading={results.isLoading}
				loadingTypes={results.loadingTypes}
				onLoadMore={results.loadMore}
				onOpen={(item) =>
					setInspected((current) =>
						current?.objectId === item.objectId ? null : item,
					)
				}
				openObjectId={inspected?.objectId ?? null}
				renderItem={(item) => (
					<ResultItem
						analysisHref={analysisPath}
						canEdit={results.canEdit}
						item={item}
						onClose={() => setInspected(null)}
						onEditWords={actions}
						projectId={projectId}
					/>
				)}
			/>
		</Stack>
	);
}
