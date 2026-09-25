import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { type ResultDensity, ResultRow } from "./ResultRow";
import classes from "./ResultsList.module.css";
import {
	fieldWords,
	primaryFields,
	risesForAttention,
	secondaryField,
} from "./resultContent";
import type { ResultActions } from "./useResultActions";

export type ResultGroupKey = "popcorn" | "tension" | "argument" | "stakeholder";

const TYPES_IN_GROUP: Record<ResultGroupKey, string[]> = {
	argument: ["argument", "deduplicated_argument"],
	popcorn: ["popcorn"],
	stakeholder: ["stakeholder"],
	tension: ["tension"],
};

/** The order the check density reads in; Present passes its own block order. */
export const GROUP_ORDER: ResultGroupKey[] = [
	"popcorn",
	"tension",
	"stakeholder",
	"argument",
];

const groupOf = (type: string): ResultGroupKey | null =>
	(Object.keys(TYPES_IN_GROUP) as ResultGroupKey[]).find((key) =>
		TYPES_IN_GROUP[key].includes(type),
	) ?? null;

const groupWords = (key: ResultGroupKey): string => {
	switch (key) {
		case "popcorn":
			return t`Popcorn`;
		case "tension":
			return t`Tensions`;
		case "stakeholder":
			return t`Stakeholders`;
		default:
			return t`Map arguments`;
	}
};

/**
 * A group shows twenty rows, then opens in place. What rose leads those
 * twenty; a row that rose beyond them waits behind "Show all" with the rest,
 * so a group of 146 is twenty rows tall until the host asks for more.
 */
const AT_REST = 20;

/** The header a jump link scrolls to. */
const headId = (key: ResultGroupKey) => `results-group-${key}`;

const stillness = (): boolean => {
	try {
		return Boolean(
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
		);
	} catch {
		return false;
	}
};

export type ResultsFilter = {
	kind: string | null;
	status: string;
	query: string;
	onChange: (next: Partial<Omit<ResultsFilter, "onChange">>) => void;
};

export type ResultsListProps = {
	density: ResultDensity;
	items: AnalysisObject[];
	actions: ResultActions;
	canEdit: boolean;
	loading?: boolean;
	error?: ReactNode;
	/** Counts per type from the endpoint, over the whole list, not the page. */
	counts?: Record<string, number>;
	/**
	 * The next page of these types, please. A group asks when it is opened, and
	 * again until it holds everything the counts promise.
	 */
	onLoadMore?: (types: string[]) => void;
	/** Types whose next page is on its way. */
	loadingTypes?: string[];
	/** The order the presentation shows its blocks in. */
	groupOrder?: ResultGroupKey[];
	/** Groups whose block is off in this presentation. */
	groupsOff?: ResultGroupKey[];
	openObjectId?: string | null;
	onOpen: (item: AnalysisObject) => void;
	/** The item, drawn under its row. */
	renderItem: (item: AnalysisObject) => ReactNode;
	/** The thin filter row. Drawn in the check density only. */
	filter?: ResultsFilter | null;
	actorName?: (actorId: string) => string | undefined;
	className?: string;
};

function matches(item: AnalysisObject, query: string): boolean {
	if (!query.trim()) return true;
	const second = secondaryField(item.type);
	const words = [
		...primaryFields(item.type).map((field) => fieldWords(item, field)),
		second ? fieldWords(item, second) : "",
		item.label ?? "",
	]
		.join(" ")
		.toLowerCase();
	return words.includes(query.trim().toLowerCase());
}

function Skeletons() {
	return (
		<div className={classes.group} data-testid="results-loading">
			<p className={classes.groupHead}>
				<span className={classes.ghost} />
			</p>
			<ul className={classes.rows}>
				{[0, 1, 2, 3].map((line) => (
					<li className={classes.row} key={line}>
						<div className={classes.skeleton}>
							<span className={classes.ghostLine} />
							<span className={`${classes.ghostLine} ${classes.ghostShort}`} />
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The findings, grouped by kind in the order the room meets them, each group
 * counted in its header. The order is set when the list opens and holds: a row
 * dealt with loses its phrase, not its place.
 */
export function ResultsList({
	actions,
	actorName,
	canEdit,
	className,
	counts,
	density,
	error,
	filter,
	groupOrder,
	groupsOff = [],
	items,
	loading,
	loadingTypes = [],
	onLoadMore,
	onOpen,
	openObjectId,
	renderItem,
}: ResultsListProps) {
	const [opened, setOpened] = useState<ResultGroupKey[]>([]);
	// The host asks for more pages; the asking itself never changes what the
	// list draws, so the effect reads the latest hand through a ref.
	const ask = useRef(onLoadMore);
	ask.current = onLoadMore;
	// The order a row has when the list opens is the order it keeps, so nothing
	// moves under the host's hand while they work.
	const places = useRef(new Map<string, { rank: number; risen: boolean }>());
	for (const item of items)
		if (!places.current.has(item.objectId))
			places.current.set(item.objectId, {
				rank: places.current.size,
				risen: risesForAttention(item),
			});

	const shown = filter
		? items.filter((item) => matches(item, filter.query))
		: items;
	const order = groupOrder ?? GROUP_ORDER;

	const groups = order
		.map((key) => {
			// What this host has of the group, whatever the search hides.
			const held = items.filter((item) => groupOf(item.type) === key).length;
			const inGroup = shown
				.filter((item) => groupOf(item.type) === key)
				.sort((one, two) => {
					const a = places.current.get(one.objectId);
					const b = places.current.get(two.objectId);
					if (a?.risen !== b?.risen) return a?.risen ? -1 : 1;
					return (a?.rank ?? 0) - (b?.rank ?? 0);
				});
			// What this group holds altogether, from the server's count per type.
			const total =
				TYPES_IN_GROUP[key].reduce(
					(sum, type) => sum + (counts?.[type] ?? 0),
					0,
				) || inGroup.length;
			const risen = inGroup.filter(
				(item) => places.current.get(item.objectId)?.risen,
			).length;
			const all = opened.includes(key);
			// At rest a group is twenty rows tall, whatever rose into them;
			// opened, it is everything.
			const room = all ? total : AT_REST;
			return {
				all,
				held,
				inGroup,
				key,
				// A page on its way for this kind: one quiet skeleton row.
				loading: TYPES_IN_GROUP[key].some((type) =>
					loadingTypes.includes(type),
				),
				risen,
				total,
				visible: inGroup.slice(0, room),
				// More is promised than this host holds: ask for the next page.
				wants: held < Math.min(room, total),
			};
		})
		// Empty groups are omitted, whether their block is on or off.
		.filter((group) => group.inGroup.length > 0);

	// One signature, so the list asks once per page and stops when it has
	// everything the counts promised.
	const asking = groups
		.filter((group) => group.wants)
		.map((group) => `${group.key}:${group.held}`)
		.join(",");
	useEffect(() => {
		if (!asking) return;
		for (const part of asking.split(",")) {
			const key = part.split(":")[0] as ResultGroupKey;
			ask.current?.(TYPES_IN_GROUP[key]);
		}
	}, [asking]);

	if (error) return <div className={classes.list}>{error}</div>;
	if (loading)
		return (
			<div className={classes.list}>
				<Skeletons />
			</div>
		);

	return (
		<div className={[classes.list, className].filter(Boolean).join(" ")}>
			{density === "check" && filter && (
				<div className={classes.filters} data-testid="results-filters">
					<label className={classes.filterLabel}>
						<Trans>Kind</Trans>
						<select
							className={classes.filterControl}
							value={filter.kind ?? ""}
							onChange={(event) =>
								filter.onChange({ kind: event.currentTarget.value || null })
							}
						>
							<option value="">{t`All kinds`}</option>
							<option value="popcorn">{groupWords("popcorn")}</option>
							<option value="tension">{groupWords("tension")}</option>
							<option value="stakeholder">{groupWords("stakeholder")}</option>
							<option value="argument">{t`Arguments`}</option>
							<option value="deduplicated_argument">{t`Combined arguments`}</option>
						</select>
					</label>
					<label className={classes.filterLabel}>
						<Trans>Status</Trans>
						<select
							className={classes.filterControl}
							value={filter.status}
							onChange={(event) =>
								filter.onChange({ status: event.currentTarget.value })
							}
						>
							<option value="active">{t`In the analysis`}</option>
							<option value="withdrawn">{t`Withdrawn`}</option>
							<option value="all">{t`Both`}</option>
						</select>
					</label>
					<label className={classes.filterLabel}>
						<Trans>Search</Trans>
						<input
							className={classes.filterControl}
							type="search"
							value={filter.query}
							onChange={(event) =>
								filter.onChange({ query: event.currentTarget.value })
							}
						/>
					</label>
				</div>
			)}

			{/* One quiet line: the kinds this list holds, each a way into its own
			    group, so a host in the map arguments can get back to the popcorn
			    without scrolling through them. */}
			{groups.length > 1 && (
				<nav
					aria-label={t`Jump to a kind`}
					className={classes.jump}
					data-testid="results-jump"
				>
					{groups.map(({ key, total }, index) => (
						<Fragment key={key}>
							{index > 0 && (
								<span aria-hidden className={classes.dot}>
									·
								</span>
							)}
							<button
								type="button"
								className={`${classes.control} ${classes.jumpLink}`}
								data-testid={`results-jump-${key}`}
								onClick={() =>
									document.getElementById(headId(key))?.scrollIntoView?.({
										// The deck's curve, or nothing at all where the host has
										// asked for nothing to move.
										behavior: stillness() ? "auto" : "smooth",
										block: "start",
									})
								}
							>
								{groupWords(key)} <span className={classes.count}>{total}</span>
							</button>
						</Fragment>
					))}
				</nav>
			)}

			{shown.length === 0 && (
				<p className={classes.empty} data-testid="results-empty">
					{/* A search that finds nothing is not an analysis that found
					    nothing, and the list does not say so. */}
					{filter &&
					(filter.query.trim() || filter.kind || filter.status !== "active") ? (
						<Trans>No findings match.</Trans>
					) : (
						<Trans>
							No findings yet. They appear after the first analysis.
						</Trans>
					)}
				</p>
			)}

			{groups.map(({ all, key, loading: more, risen, total, visible }) => {
				const off = groupsOff.includes(key);
				return (
					<section className={classes.group} key={key}>
						{/* The header holds the top of the scroller while its own rows
						    pass under it, so the host always knows which kind they
						    are reading. */}
						<h3 className={classes.groupHead} id={headId(key)}>
							{groupWords(key)} <span className={classes.count}>{total}</span>
						</h3>
						{off ? (
							<p className={classes.empty}>
								<Trans>not in this presentation</Trans>
							</p>
						) : (
							<>
								<ul className={classes.rows}>
									{visible.map((item, index) => (
										<Fragment key={item.objectId}>
											{/* One graphite rule under the rows that rose. */}
											{index === risen && risen > 0 && (
												<li
													aria-hidden
													className={classes.rule}
													data-testid="results-rule"
												/>
											)}
											<ResultRow
												actions={actions}
												actorName={actorName}
												canEdit={canEdit}
												density={density}
												item={item}
												onOpen={() => onOpen(item)}
												open={openObjectId === item.objectId}
											>
												{renderItem(item)}
											</ResultRow>
										</Fragment>
									))}
									{/* A page on its way sits where its rows will: one row
									    in the row's own skeleton, no spinner. */}
									{more && (
										<li
											className={classes.row}
											data-testid={`results-loading-${key}`}
										>
											<div className={classes.skeleton}>
												<span className={classes.ghostLine} />
												<span
													className={`${classes.ghostLine} ${classes.ghostShort}`}
												/>
											</div>
										</li>
									)}
								</ul>
								{!all && visible.length < total && (
									<button
										type="button"
										className={`${classes.control} ${classes.showAll}`}
										data-testid={`results-show-all-${key}`}
										onClick={() => setOpened((keys) => [...keys, key])}
									>
										<Trans>Show all {total}</Trans>
									</button>
								)}
							</>
						)}
					</section>
				);
			})}
		</div>
	);
}
