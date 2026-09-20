import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { rungWord } from "../ResultItem";
import {
	conversationWords,
	evidenceGroups,
	fieldWords,
	resultFields,
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

const COLUMNS = 6;

/**
 * The stakeholders: a few of them, three short fields each, all three
 * rewordable in place under the pencil. The rung is said after the name only
 * when it is not "voiced", which is the expected one.
 */
export function StakeholdersTab({
	items,
	onOpen,
	openObjectId,
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
						<Trans>Name</Trans>
					</th>
					<th scope="col">
						<Trans>Role</Trans>
					</th>
					<th scope="col">
						<Trans>Stake</Trans>
					</th>
					<th scope="col">
						<Trans>Source</Trans>
					</th>
				</>
			}
			ids={ids}
			selection={shape.selection}
			testId="curate-stakeholders"
		>
			{items.map((item) => {
				const rung = rungWord(resultFields(item).rung);
				return (
					<CurateRow
						{...shape}
						cells={(edit) => (
							<>
								<td className={classes.statement}>
									<AttentionLead item={item} />
									<RowWords
										edit={edit}
										field="name"
										label={t`The name of this stakeholder`}
										words={fieldWords(item, "name") || (item.label ?? "")}
									/>
									{rung && <span className={classes.rung}> {rung}</span>}
								</td>
								<td className={classes.cell}>
									<RowWords
										edit={edit}
										field="role"
										label={t`This stakeholder's role`}
										words={fieldWords(item, "role")}
									/>
								</td>
								<td className={`${classes.cell} ${classes.clamp2}`}>
									<RowWords
										edit={edit}
										field="stake"
										label={t`What is at stake here`}
										words={fieldWords(item, "stake")}
									/>
								</td>
								<td className={classes.cell}>
									{conversationWords(item, evidenceGroups(item)[0])}
								</td>
							</>
						)}
						columns={COLUMNS}
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
							/>
						)}
						testId={`curate-stakeholder-${item.objectId}`}
					/>
				);
			})}
		</CurateTable>
	);
}
