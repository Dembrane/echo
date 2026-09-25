import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useResultsList, useResultsVisit } from "@/components/analysis";
import { usePopcornSettingsMutation } from "@/components/popcorn/hooks";
import {
	ALWAYS_ON_BLOCK,
	blocksPatch,
	orderedBlocks,
	PRESENTATION_BLOCKS,
	type PresentationBlock,
} from "@/components/present/blocks";
import type { Presentation } from "@/components/present/hooks";
import { type HoldBackAdapter, useResultActions } from "@/components/results";
import { CuratePanel } from "@/components/results/curate/CuratePanel";
import { testId } from "@/lib/testUtils";

/**
 * Which tab this panel is on, kept in the address so a reload comes back to
 * it. `?results=1` opened this panel before it had tabs and still does: any
 * value that is not one of the four names falls through to the first tab the
 * presentation shows.
 */
export const RESULTS_PARAM = "results";

export function resultsTab(
	params: URLSearchParams,
	blocks: PresentationBlock[],
): PresentationBlock {
	const asked = params.get(RESULTS_PARAM);
	return (PRESENTATION_BLOCKS as readonly string[]).includes(asked ?? "")
		? (asked as PresentationBlock)
		: (blocks[0] ?? ALWAYS_ON_BLOCK);
}

/**
 * The results the room will see, for the host to reword, hide or read the
 * evidence of. A sibling of the presentation editor, not a part of it: that
 * one is the style and structure of the screen, this one is what the screen
 * says.
 */
export function PresentResultsPanel({
	projectId,
	presentation,
	className,
	onTabChange,
}: {
	projectId: string;
	presentation: Presentation;
	className?: string;
	/** Told which tab is being read, so the preview above can follow. */
	onTabChange?: (block: PresentationBlock) => void;
}) {
	const { workspaceId } = useParams<{ workspaceId?: string }>();
	const [params, setParams] = useSearchParams();
	const results = useResultsList(projectId);
	// What is new is new since the host last opened this list; leaving it marks
	// it seen.
	useResultsVisit(projectId);
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
	const selected = resultsTab(params, blocks);

	/**
	 * Hiding a finding writes its id into the presentation draft's
	 * `hidden_items`, which keeps no reason and needs none: the settings route
	 * takes a list of ids (`PresentationBody` in `dembrane/api/v2/bff/popcorn.py`)
	 * and validates nothing else. The reason a host chooses to add is kept for
	 * the page by `useResultActions`; the curation log endpoint is what will
	 * make it outlive a reload, and nothing on this screen moves when it lands.
	 */
	// The click is the decision, so the row dims on the click and not on the
	// round trip. What this page decided leads; the draft catches up and the
	// two agree, and an entry that agrees is dropped.
	const [decided, setDecided] = useState<Record<string, boolean>>({});
	const pending = useMemo(() => {
		const kept: Record<string, boolean> = {};
		for (const [objectId, held] of Object.entries(decided))
			if (hidden.includes(objectId) !== held) kept[objectId] = held;
		return kept;
	}, [decided, hidden]);

	const holdBack: HoldBackAdapter = useMemo(
		() => ({
			isHeld: (objectId) => pending[objectId] ?? hidden.includes(objectId),
			setHeld: (objectId, held) => {
				setDecided((old) => ({ ...old, [objectId]: held }));
				save.mutate({
					presentation: {
						hidden_items: held
							? [...new Set([...hidden, objectId])]
							: hidden.filter((id) => id !== objectId),
					},
				});
			},
			// A selection is one decision, so it is one write: the route takes the
			// whole list, and eleven writes of it would race each other.
			setManyHeld: (objectIds, held) => {
				setDecided((old) => ({
					...old,
					...Object.fromEntries(objectIds.map((id) => [id, held])),
				}));
				save.mutate({
					presentation: {
						hidden_items: held
							? [...new Set([...hidden, ...objectIds])]
							: hidden.filter((id) => !objectIds.includes(id)),
					},
				});
			},
		}),
		[hidden, pending, save.mutate],
	);
	const actions = useResultActions({ holdBack, projectId });

	return (
		<Stack
			component="section"
			aria-label={t`Review results`}
			className={className}
			gap="sm"
			{...testId("present-results-panel")}
		>
			<Text fw={500}>
				<Trans>Review results</Trans>
			</Text>
			<Text size="sm">
				<Trans>
					Change the wording, read the evidence, or keep a finding out of this
					presentation. Shared results stay available in Analysis.
				</Trans>
			</Text>
			<CuratePanel
				actions={actions}
				analysisHref={analysisPath}
				blocks={blocks}
				canEdit={results.canEdit}
				counts={results.counts}
				error={
					results.isError ? (
						<Text>
							<Trans>Results could not be loaded.</Trans>
						</Text>
					) : null
				}
				items={results.items}
				loading={results.isLoading}
				onLoadMore={results.loadMore}
				onSelect={(block) => {
					setParams(
						(old) => {
							const next = new URLSearchParams(old);
							next.set(RESULTS_PARAM, block);
							return next;
						},
						{ replace: true },
					);
					onTabChange?.(block);
				}}
				// The editor's own switch, through the editor's own patch: one
				// write path for turning a tab on, wherever the host does it.
				onTurnOn={
					results.canEdit
						? (block) =>
								save.mutate({ presentation: blocksPatch(blocks, block, true) })
						: null
				}
				projectId={projectId}
				selected={selected}
			/>
		</Stack>
	);
}
