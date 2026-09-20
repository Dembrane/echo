import { Trans } from "@lingui/react/macro";
import { Switch } from "@mantine/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	PRESENTATION_BLOCKS,
	type PresentationBlock,
} from "@/components/present/blocks";
import { useResultFeedback } from "../feedback/useResultFeedback";
import { risesForAttention } from "../resultContent";
import type { ResultActions } from "../useResultActions";
import { ARGUMENTS_AT_REST, ArgumentsTab } from "./ArgumentsTab";
import { CurateTabs, panelId, tabId, tabWords } from "./CurateTabs";
import classes from "./curate.module.css";
import { POPCORN_AT_REST, PopcornTab } from "./PopcornTab";
import { StakeholdersTab } from "./StakeholdersTab";
import type { ShapeProps } from "./shape";
import { TensionsTab } from "./TensionsTab";
import { useSelection } from "./useSelection";

/** The types of finding each tab draws from. */
export const TYPES_IN_TAB: Record<PresentationBlock, string[]> = {
	map: ["argument", "deduplicated_argument"],
	popcorn: ["popcorn"],
	stakeholders: ["stakeholder"],
	tensions: ["tension"],
};

const tabOfType = (type: string): PresentationBlock | null =>
	(Object.keys(TYPES_IN_TAB) as PresentationBlock[]).find((block) =>
		TYPES_IN_TAB[block].includes(type),
	) ?? null;

/** Nothing here yet, in the tab's own words. */
function Empty({ block }: { block: PresentationBlock }) {
	return (
		<p className={classes.empty} data-testid="curate-empty">
			{block === "popcorn" ? (
				<Trans>No popcorn yet. They appear after the first analysis.</Trans>
			) : block === "tensions" ? (
				<Trans>No tensions yet. They appear after the first analysis.</Trans>
			) : block === "stakeholders" ? (
				<Trans>
					No stakeholders yet. They appear after the first analysis.
				</Trans>
			) : (
				<Trans>No arguments yet. They appear after the first analysis.</Trans>
			)}
		</p>
	);
}

/**
 * Waiting, in the shape of what is coming: rows, in the table every tab is
 * drawn in. No spinner — a spinner says only that something is happening, and
 * the host already knows that.
 */
function Skeleton() {
	return (
		<table className={classes.table} data-testid="curate-loading">
			<tbody>
				{[0, 1, 2, 3, 4].map((line) => (
					<tr className={classes.ghostRow} key={line}>
						<td>
							<span className={classes.ghostLine} />
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export type CuratePanelProps = ShapeProps & {
	items: AnalysisObject[];
	/** Per type, over the whole list, not the page the host holds. */
	counts?: Record<string, number>;
	loading?: boolean;
	error?: ReactNode;
	/** The next page of these types, please. */
	onLoadMore?: (types: string[]) => void;
	/** The blocks this presentation shows, in the order the room meets them. */
	blocks: PresentationBlock[];
	/** The tab being read, and the way to change it. */
	selected: PresentationBlock;
	onSelect: (block: PresentationBlock) => void;
	/** Turning a block on from here, through the editor's own write path. */
	onTurnOn?: ((block: PresentationBlock) => void) | null;
	actions: ResultActions;
};

/**
 * The results the room will see, in four tabs, each shaped for its data.
 *
 * One long grouped list asked a host to read 146 map arguments in the same
 * shape as 4 tensions. These are four different jobs: culling popcorn fast,
 * reading a handful of tensions whole, working a table of arguments, and
 * checking a few stakeholders. The tabs are the room's own four, so the panel,
 * the preview above it and the editor beside it all say the same names.
 */
export function CuratePanel({
	actions,
	blocks,
	counts = {},
	error,
	items,
	loading,
	onLoadMore,
	onSelect,
	onTurnOn,
	selected,
	...shape
}: CuratePanelProps) {
	const [open, setOpen] = useState<string | null>(null);
	const [showingHidden, setShowingHidden] = useState(false);
	const [allPopcorn, setAllPopcorn] = useState(false);
	// The ticks belong to the tab they were made in, and the thumbs to the
	// whole panel: one hook, so a rating made in one tab is the same rating
	// the row shows when the host comes back to it.
	const selection = useSelection();
	const feedback = useResultFeedback(shape.projectId);
	// The order a finding has when the panel opens is the order it keeps, so
	// nothing moves under the host's hand while they work.
	const places = useRef(new Map<string, { rank: number; risen: boolean }>());
	for (const item of items)
		if (!places.current.has(item.objectId))
			places.current.set(item.objectId, {
				rank: places.current.size,
				risen: risesForAttention(item),
			});

	const ask = useRef(onLoadMore);
	ask.current = onLoadMore;

	const all = useMemo(() => {
		const held = items
			.filter((item) => tabOfType(item.type) === selected)
			.sort((one, two) => {
				const a = places.current.get(one.objectId);
				const b = places.current.get(two.objectId);
				if (a?.risen !== b?.risen) return a?.risen ? -1 : 1;
				return (a?.rank ?? 0) - (b?.rank ?? 0);
			});
		return held;
	}, [items, selected]);

	const hiddenCount = all.filter((item) =>
		actions.isHeld(item.objectId),
	).length;
	const shown = showingHidden
		? all.filter((item) => actions.isHeld(item.objectId))
		: all;

	const total =
		TYPES_IN_TAB[selected].reduce(
			(sum, type) => sum + (counts[type] ?? 0),
			0,
		) || all.length;
	const tabCounts = Object.fromEntries(
		PRESENTATION_BLOCKS.map((block) => [
			block,
			TYPES_IN_TAB[block].reduce((sum, type) => sum + (counts[type] ?? 0), 0) ||
				items.filter((item) => tabOfType(item.type) === block).length,
		]),
	) as Record<PresentationBlock, number>;

	// The room's own order, so a tab that is off still stands where the room
	// would have met it.
	const off = PRESENTATION_BLOCKS.filter((block) => !blocks.includes(block));
	// On blocks in the order the room meets them, then the ones that are off.
	const order = [...blocks, ...off];
	const isOff = off.includes(selected);

	const askForAll = () => ask.current?.(TYPES_IN_TAB[selected]);

	// More is promised than this host holds, and the tab is being read: ask for
	// the next page, once per page, and stop when the counts are satisfied.
	const atRest = selected === "map" ? ARGUMENTS_AT_REST : POPCORN_AT_REST;
	const wants = all.length < Math.min(atRest, total) ? all.length : -1;
	useEffect(() => {
		if (wants < 0) return;
		ask.current?.(TYPES_IN_TAB[selected]);
	}, [selected, wants]);

	const onOpen = (item: AnalysisObject) =>
		setOpen((current) => (current === item.objectId ? null : item.objectId));

	const shapeProps = { ...shape, actions, feedback, selection };

	const body = () => {
		if (loading) return <Skeleton />;
		if (shown.length === 0)
			return showingHidden ? (
				<p className={classes.empty}>
					<Trans>Nothing is hidden from this presentation.</Trans>
				</p>
			) : (
				<Empty block={selected} />
			);
		if (selected === "tensions")
			return (
				<TensionsTab
					{...shapeProps}
					items={shown}
					onOpen={onOpen}
					openObjectId={open}
				/>
			);
		if (selected === "stakeholders")
			return (
				<StakeholdersTab
					{...shapeProps}
					items={shown}
					onOpen={onOpen}
					openObjectId={open}
				/>
			);
		if (selected === "map")
			return (
				<ArgumentsTab
					{...shapeProps}
					items={shown}
					onNeedsAll={askForAll}
					onOpen={onOpen}
					openObjectId={open}
					total={total}
				/>
			);
		const visible = allPopcorn ? shown : shown.slice(0, POPCORN_AT_REST);
		return (
			<>
				<PopcornTab
					{...shapeProps}
					items={visible}
					onOpen={onOpen}
					openObjectId={open}
				/>
				{visible.length < Math.max(shown.length, total) && (
					<button
						type="button"
						className={`${classes.control} ${classes.showAll}`}
						data-testid="curate-show-all-popcorn"
						onClick={() => {
							setAllPopcorn(true);
							askForAll();
						}}
					>
						<Trans>Show all {total}</Trans>
					</button>
				)}
			</>
		);
	};

	if (error) return <div className={classes.panel}>{error}</div>;

	return (
		<div className={classes.panel} data-testid="curate-panel">
			<CurateTabs
				blocks={order}
				counts={tabCounts}
				off={off}
				onSelect={(block) => {
					onSelect(block);
					setOpen(null);
					setShowingHidden(false);
					setAllPopcorn(false);
					selection.clear();
				}}
				selected={selected}
			/>

			<div
				aria-labelledby={tabId(selected)}
				className={classes.tabPanel}
				id={panelId(selected)}
				role="tabpanel"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a tabpanel is given the focus when its tab is chosen, which is what the pattern asks for
				tabIndex={0}
			>
				<div className={classes.panelHead}>
					<span className={classes.headWords}>
						{hiddenCount > 0 && (
							<button
								type="button"
								aria-pressed={showingHidden}
								className={`${classes.control} ${classes.quiet} ${classes.toggle}`}
								data-testid="curate-hidden-filter"
								onClick={() => setShowingHidden((on) => !on)}
							>
								<Trans>{hiddenCount} hidden</Trans>
							</button>
						)}
					</span>
				</div>

				{/* A block that is off is still readable: a host deciding whether to
				    turn it on wants to see what they would be turning on, and the
				    findings under the line are dimmed the way a hidden row's are. */}
				{isOff && (
					<div className={classes.offNotice} data-testid="curate-off">
						<p className={classes.offLine}>
							<Trans>Not in this presentation.</Trans>
						</p>
						{onTurnOn && (
							<Switch
								checked={false}
								label={tabWords(selected)}
								onChange={() => onTurnOn(selected)}
								{...{ "data-testid": `curate-turn-on-${selected}` }}
							/>
						)}
					</div>
				)}

				<div className={isOff ? classes.dimmed : undefined}>{body()}</div>
			</div>
		</div>
	);
}
