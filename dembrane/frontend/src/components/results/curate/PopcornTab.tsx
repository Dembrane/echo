import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	conversationWords,
	evidenceGroups,
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

/**
 * Forty at rest, then the whole set. A popcorn tab is a culling job: the host
 * reads fast down the rows and takes phrases out, so the page holds enough to
 * get a rhythm going without asking for 146 rows nobody scrolls.
 */
export const POPCORN_AT_REST = 40;

/** The columns between the tick and the tools. */
const COLUMNS = 4;

/**
 * The popcorn tab: the phrase, the conversation it came from, and the tools.
 * One column of rows, wrapped over as many lines as a phrase needs.
 */
export function PopcornTab({
	items,
	openObjectId,
	onOpen,
	...shape
}: TableProps & {
	items: AnalysisObject[];
	openObjectId: string | null;
	onOpen: (item: AnalysisObject) => void;
}) {
	const ids = items.map((item) => item.objectId);
	return (
		<CurateTable
			actions={shape.actions}
			heads={
				<>
					<th scope="col">
						<Trans>Popcorn phrase</Trans>
					</th>
					<th scope="col">
						<Trans>Source</Trans>
					</th>
				</>
			}
			ids={ids}
			selection={shape.selection}
			testId="curate-popcorn"
		>
			{items.map((item) => {
				const groups = evidenceGroups(item);
				const phrase = fieldWords(item, "phrase") || (item.label ?? "");
				return (
					<CurateRow
						{...shape}
						cells={(edit) => (
							<>
								<td className={classes.statement}>
									<AttentionLead item={item} thin={false} />
									<RowWords
										edit={edit}
										field="phrase"
										label={t`The words of this finding`}
										words={phrase}
									/>
								</td>
								<td className={classes.cell}>
									{conversationWords(item, groups[0])}
								</td>
							</>
						)}
						columns={COLUMNS}
						ids={ids}
						item={item}
						key={item.objectId}
						onOpen={() => onOpen(item)}
						open={openObjectId === item.objectId}
						// Opened, a popcorn shows the one thing the row cannot: the
						// sentence the phrase was cut from, with the phrase marked.
						opened={() => (
							<CurateOpen
								actions={shape.actions}
								analysisHref={shape.analysisHref}
								canEdit={shape.canEdit}
								item={item}
								projectId={shape.projectId}
								quotes={groups.flatMap((group) =>
									group.quotes.map((quote) => ({
										cut: phrase,
										text: quote,
										where: conversationWords(item, group),
									})),
								)}
							/>
						)}
						testId={`curate-pop-${item.objectId}`}
					/>
				);
			})}
		</CurateTable>
	);
}
