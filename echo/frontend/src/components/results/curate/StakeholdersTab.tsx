import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { rungWord } from "../ResultItem";
import { fieldWords, resultFields } from "../resultContent";
import { EditableWords, useWordsEdit } from "../resultEditing";
import {
	attentionPhrase,
	HideControl,
	QuietLine,
	WordsStep,
} from "./CurateMeta";
import { CurateOpen } from "./CurateOpen";
import classes from "./curate.module.css";
import { openOnClick, type ShapeProps } from "./shape";
import { useHide } from "./useHide";

function StakeholderRow({
	actions,
	analysisHref,
	canEdit,
	item,
	onOpen,
	open,
	projectId,
}: ShapeProps & { item: AnalysisObject; open: boolean; onOpen: () => void }) {
	const hide = useHide({ actions, objectId: item.objectId });
	const edit = useWordsEdit({ actions: canEdit ? actions : null, item });
	// The rung is stated only when it is not "voiced", which is the expected
	// one: a column saying "voiced" on every row says nothing.
	const rung = rungWord(resultFields(item).rung);

	return (
		<>
			<tr
				className={classes.bodyRow}
				data-held={hide.held || undefined}
				data-testid={`curate-stakeholder-${item.objectId}`}
				onClick={(event) => openOnClick(event, onOpen)}
			>
				<td className={classes.statement}>
					<EditableWords
						edit={edit}
						field="name"
						label={t`The name of this stakeholder`}
						words={fieldWords(item, "name") || (item.label ?? "")}
					/>
				</td>
				<td className={classes.cell}>
					<EditableWords
						edit={edit}
						field="role"
						label={t`This stakeholder's role`}
						words={fieldWords(item, "role")}
					/>
				</td>
				<td className={classes.cell}>
					<EditableWords
						clamp={classes.clamp2}
						edit={edit}
						field="stake"
						label={t`What is at stake here`}
						words={fieldWords(item, "stake")}
					/>
				</td>
				<td className={classes.cell}>{rung}</td>
				<td className={classes.controlCell}>
					<HideControl hide={hide} />
				</td>
			</tr>
			{(hide.held || hide.asking || attentionPhrase(item) || edit.asking) && (
				<tr>
					<td className={classes.openedCell} colSpan={5}>
						<WordsStep edit={edit} objectId={item.objectId} />
						<QuietLine
							actions={actions}
							hide={hide}
							lead={attentionPhrase(item)}
							objectId={item.objectId}
						/>
					</td>
				</tr>
			)}
			{open && (
				<tr>
					<td className={classes.openedCell} colSpan={5}>
						<CurateOpen
							actions={actions}
							analysisHref={analysisHref}
							canEdit={canEdit}
							item={item}
							projectId={projectId}
						/>
					</td>
				</tr>
			)}
		</>
	);
}

/**
 * The stakeholders: a few of them, three short fields each, all three
 * rewordable where they stand. A short table, no filters: there is nothing
 * here a host has to search through.
 */
export function StakeholdersTab({
	items,
	onOpen,
	openObjectId,
	...shape
}: ShapeProps & {
	items: AnalysisObject[];
	openObjectId: string | null;
	onOpen: (item: AnalysisObject) => void;
}) {
	return (
		<table className={classes.table} data-testid="curate-stakeholders">
			<thead>
				<tr>
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
						<Trans>How they were named</Trans>
					</th>
					<th scope="col">
						<span className={classes.said}>
							<Trans>Hide</Trans>
						</span>
					</th>
				</tr>
			</thead>
			<tbody>
				{items.map((item) => (
					<StakeholderRow
						{...shape}
						item={item}
						key={item.objectId}
						onOpen={() => onOpen(item)}
						open={openObjectId === item.objectId}
					/>
				))}
			</tbody>
		</table>
	);
}
