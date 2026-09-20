import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { type ReactNode, useMemo, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	conversationWords,
	evidenceGroups,
	factCheckJustification,
	factCheckVerdict,
	fieldWords,
} from "../resultContent";
import { AttentionLead } from "./CurateMeta";
import { CurateOpen } from "./CurateOpen";
import {
	CurateRow,
	CurateTable,
	RowWords,
	type TableProps,
} from "./CurateTable";
import classes from "./curate.module.css";

/** Twenty-five rows of a table is a screenful; the rest waits to be asked for. */
export const ARGUMENTS_AT_REST = 25;

export type Stance = "all" | "for" | "against";
export type SortColumn = "stance" | "conversation" | "factCheck";
export type Sort = { column: SortColumn; ascending: boolean } | null;

/** The stance in words. The dashboard has no red and no green to say it in. */
export const stanceOf = (item: AnalysisObject): "for" | "against" | null => {
	const valence = item.payload?.valence;
	if (valence === "positive") return "for";
	if (valence === "negative") return "against";
	return null;
};

const stanceWords = (stance: "for" | "against" | null): ReactNode =>
	stance === "for" ? (
		<Trans>for</Trans>
	) : stance === "against" ? (
		<Trans>against</Trans>
	) : null;

/**
 * What the fact-check column says. A verdict is a word, and only the two that
 * disagree are said as a sentence: the rest of the table is quiet about
 * findings nobody has doubted.
 */
export const factCheckWords = (item: AnalysisObject): ReactNode => {
	const verdict = factCheckVerdict(item);
	if (!verdict) return null;
	if (verdict === "false" || verdict === "contested")
		return <Trans>the fact-check disagrees</Trans>;
	return verdict;
};

/** Where an argument comes from, for the column and the conversation filter. */
export const conversationOf = (item: AnalysisObject): string =>
	conversationWords(item, evidenceGroups(item)[0]);

/** What a search over the arguments reads. */
const searchable = (item: AnalysisObject): string =>
	`${fieldWords(item, "statement")} ${item.label ?? ""} ${conversationOf(item)}`.toLowerCase();

/**
 * Sorting is over what the host holds. The panel asks for the rest of the
 * pages before a sort or a filter is honoured, so a table that says it is
 * sorted by stance is sorted over all 146 and not over the first 25.
 */
export function sortArguments(
	items: AnalysisObject[],
	sort: Sort,
): AnalysisObject[] {
	if (!sort) return items;
	const key = (item: AnalysisObject): string => {
		if (sort.column === "stance") return stanceOf(item) ?? "";
		if (sort.column === "conversation") return conversationOf(item);
		return factCheckVerdict(item) ?? "";
	};
	return [...items].sort((one, two) => {
		const compared = key(one).localeCompare(key(two));
		return sort.ascending ? compared : -compared;
	});
}

export function filterArguments(
	items: AnalysisObject[],
	{
		query,
		stance,
		conversation,
	}: { query: string; stance: Stance; conversation: string },
): AnalysisObject[] {
	const needle = query.trim().toLowerCase();
	return items.filter((item) => {
		if (needle && !searchable(item).includes(needle)) return false;
		if (stance !== "all" && stanceOf(item) !== stance) return false;
		if (conversation && conversationOf(item) !== conversation) return false;
		return true;
	});
}

function SortHead({
	column,
	label,
	sort,
	onSort,
}: {
	column: SortColumn;
	label: ReactNode;
	sort: Sort;
	onSort: (column: SortColumn) => void;
}) {
	const on = sort?.column === column;
	return (
		<th
			scope="col"
			aria-sort={on ? (sort.ascending ? "ascending" : "descending") : "none"}
		>
			<button
				type="button"
				className={classes.sortHead}
				data-testid={`curate-sort-${column}`}
				onClick={() => onSort(column)}
			>
				{label}
				{on &&
					(sort.ascending ? (
						<CaretUpIcon aria-hidden className={classes.caret} size={12} />
					) : (
						<CaretDownIcon aria-hidden className={classes.caret} size={12} />
					))}
			</button>
		</th>
	);
}

export type ArgumentsTabProps = TableProps & {
	items: AnalysisObject[];
	openObjectId: string | null;
	onOpen: (item: AnalysisObject) => void;
	/** Every argument the server promises, so "N of 146" is honest. */
	total: number;
	/** Ask for the rest before a sort or a filter is honoured. */
	onNeedsAll: () => void;
};

/**
 * The map arguments: 146 of them, four things to know about each, and the one
 * shape in this panel that is genuinely a table. It sorts and filters over
 * what the host holds, and asks for the rest of the pages the moment either is
 * touched, so a sorted table is sorted over all of them.
 */
export function ArgumentsTab({
	items,
	onNeedsAll,
	onOpen,
	openObjectId,
	total,
	...shape
}: ArgumentsTabProps) {
	const [query, setQuery] = useState("");
	const [stance, setStance] = useState<Stance>("all");
	const [conversation, setConversation] = useState("");
	const [sort, setSort] = useState<Sort>(null);
	const [all, setAll] = useState(false);

	const conversations = useMemo(
		() =>
			[...new Set(items.map(conversationOf).filter(Boolean))].sort((one, two) =>
				one.localeCompare(two),
			),
		[items],
	);

	const shown = sortArguments(
		filterArguments(items, { conversation, query, stance }),
		sort,
	);
	const visible = all ? shown : shown.slice(0, ARGUMENTS_AT_REST);

	// Sorting or filtering over a first page would be a lie about the whole.
	const askForAll = () => onNeedsAll();
	const ids = visible.map((item) => item.objectId);

	const onSort = (column: SortColumn) => {
		askForAll();
		setSort((old) =>
			old?.column === column
				? { ascending: !old.ascending, column }
				: { ascending: true, column },
		);
	};

	return (
		<div className={classes.tableWrap}>
			<div className={classes.filters} data-testid="curate-argument-filters">
				<div className={classes.filterGroup}>
					<label className={classes.filterLabel}>
						<Trans>Search arguments</Trans>
						<input
							className={classes.filterControl}
							type="search"
							value={query}
							onChange={(event) => {
								setQuery(event.currentTarget.value);
								askForAll();
							}}
						/>
					</label>
					<span className={classes.toggles}>
						{(["all", "for", "against"] as const).map((value) => (
							<button
								key={value}
								type="button"
								aria-pressed={stance === value}
								className={`${classes.control} ${classes.quiet} ${classes.toggle}`}
								data-testid={`curate-stance-${value}`}
								onClick={() => {
									setStance(value);
									askForAll();
								}}
							>
								{value === "all" ? (
									<Trans>All</Trans>
								) : value === "for" ? (
									<Trans>for</Trans>
								) : (
									<Trans>against</Trans>
								)}
							</button>
						))}
					</span>
					<label className={classes.filterLabel}>
						<Trans>Conversation</Trans>
						<select
							className={classes.filterControl}
							value={conversation}
							onChange={(event) => {
								setConversation(event.currentTarget.value);
								askForAll();
							}}
						>
							<option value="">{t`All conversations`}</option>
							{conversations.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
					</label>
				</div>
				<span className={classes.count} data-testid="curate-argument-count">
					<Trans>
						{shown.length} of {total}
					</Trans>
				</span>
			</div>

			<CurateTable
				actions={shape.actions}
				heads={
					<>
						<th scope="col">
							<Trans>Statement</Trans>
						</th>
						<SortHead
							column="stance"
							label={<Trans>Stance</Trans>}
							onSort={onSort}
							sort={sort}
						/>
						<SortHead
							column="conversation"
							label={<Trans>Source</Trans>}
							onSort={onSort}
							sort={sort}
						/>
						<SortHead
							column="factCheck"
							label={<Trans>Fact-check</Trans>}
							onSort={onSort}
							sort={sort}
						/>
					</>
				}
				ids={ids}
				selection={shape.selection}
				testId="curate-arguments"
			>
				{visible.map((item) => {
					const justification = factCheckJustification(item);
					const verdict = factCheckWords(item);
					return (
						<CurateRow
							{...shape}
							cells={(edit) => (
								<>
									<td className={classes.statement}>
										<AttentionLead item={item} />
										<RowWords
											edit={edit}
											field="statement"
											label={t`The words of this finding`}
											words={
												fieldWords(item, "statement") || (item.label ?? "")
											}
										/>
										{/* A combined argument reads the same as any other; the
										    word says what it is without a badge to say it in. */}
										{item.type === "deduplicated_argument" && (
											<span className={classes.cell}>
												{" "}
												<Trans>combined</Trans>
											</span>
										)}
									</td>
									<td className={classes.cell}>
										{stanceWords(stanceOf(item))}
									</td>
									<td className={`${classes.cell} ${classes.clamp2}`}>
										{conversationOf(item)}
									</td>
									<td className={`${classes.cell} ${classes.clamp2}`}>
										{verdict}
									</td>
								</>
							)}
							columns={6}
							ids={ids}
							item={item}
							key={item.objectId}
							onOpen={() => onOpen(item)}
							open={openObjectId === item.objectId}
							opened={() => (
								<CurateOpen
									actions={shape.actions}
									analysisHref={shape.analysisHref}
									canEdit={shape.canEdit}
									item={item}
									projectId={shape.projectId}
									verdict={
										justification ? (
											<>
												{verdict} {justification}
											</>
										) : null
									}
								/>
							)}
							testId={`curate-argument-${item.objectId}`}
						/>
					);
				})}
			</CurateTable>

			{!all && shown.length > visible.length && (
				<button
					type="button"
					className={`${classes.control} ${classes.showAll}`}
					data-testid="curate-show-all-argument"
					onClick={() => {
						setAll(true);
						askForAll();
					}}
				>
					<Trans>Show all {shown.length}</Trans>
				</button>
			)}
		</div>
	);
}
