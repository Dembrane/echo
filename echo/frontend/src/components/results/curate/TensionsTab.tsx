import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	conversationWords,
	evidenceGroups,
	fieldWords,
	hasPoles,
	type PoleQuote,
	resultEvidence,
	tensionQuotes,
} from "../resultContent";
import { AttentionLead } from "./CurateMeta";
import {
	CurateActions,
	type CurateQuote,
	curateQuotes,
	Quote,
} from "./CurateOpen";
import {
	CurateRow,
	CurateTable,
	RowWords,
	type TableProps,
} from "./CurateTable";
import classes from "./curate.module.css";

const COLUMNS = 4;

/** The quotes of one pole, each with the conversation the payload named. */
function quotesOfPole(
	item: AnalysisObject,
	quotes: PoleQuote[],
	pole: "A" | "B" | null,
): CurateQuote[] {
	return quotes
		.filter((quote) => quote.pole === pole)
		.map((quote) => ({ text: quote.text, where: conversationWords(item) }));
}

/**
 * Where a tension comes from. Its quotes keep only the conversation's id, so
 * the name is there when the whole tension rests on one conversation and the
 * server named it, and it is a count otherwise: an id is not a name.
 */
function sourceWords(item: AnalysisObject): string {
	const named = evidenceGroups(item)
		.map((group) => group.label)
		.filter(Boolean);
	if (named.length > 0) return [...new Set(named)].join(", ");
	const one = conversationWords(item);
	if (one) return one;
	const { conversations } = resultEvidence(item);
	return conversations > 0
		? plural(conversations, { one: "# conversation", other: "# conversations" })
		: "";
}

/**
 * The tensions tab: both poles with the arrows between them, the knot under
 * them in soft ink, and the evidence a row-click away like every other tab.
 */
export function TensionsTab({
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
						<Trans>Tension</Trans>
					</th>
					<th scope="col">
						<Trans>Source</Trans>
					</th>
				</>
			}
			ids={ids}
			selection={shape.selection}
			testId="curate-tensions"
		>
			{items.map((item) => {
				const poleA = fieldWords(item, "poleA");
				const poleB = fieldWords(item, "poleB");
				const quotes = tensionQuotes(item);
				return (
					<CurateRow
						{...shape}
						cells={(edit) => (
							<>
								<td className={classes.statement}>
									<AttentionLead item={item} />
									{/* Both poles on one line, the arrows travelling with
									    the second so a tension that wraps never leaves the
									    glyph hanging. */}
									<span className={classes.poles}>
										<RowWords
											edit={edit}
											field="poleA"
											label={t`One side of this tension`}
											words={poleA}
										/>
										<span className={classes.pole}>
											<ArrowsLeftRightIcon
												aria-hidden
												className={classes.arrows}
												size="0.9em"
											/>
											<RowWords
												edit={edit}
												field="poleB"
												label={t`The other side of this tension`}
												words={poleB}
											/>
										</span>
									</span>
									<span className={classes.knot}>
										<RowWords
											edit={edit}
											field="knot"
											label={t`What this tension is about`}
											words={fieldWords(item, "knot")}
										/>
									</span>
									{/* What would resolve it is not a column: it is a fourth
									    field, and it stands under the knot while the row is
									    being written. */}
									{edit.on && (
										<span className={classes.resolve}>
											<span className={classes.resolveLabel}>
												<Trans>To resolve:</Trans>{" "}
											</span>
											<RowWords
												edit={edit}
												field="toResolve"
												label={t`What would resolve this tension`}
												words={fieldWords(item, "toResolve")}
											/>
										</span>
									)}
								</td>
								<td className={classes.cell}>{sourceWords(item)}</td>
							</>
						)}
						columns={COLUMNS}
						ids={ids}
						item={item}
						key={item.objectId}
						onOpen={() => onOpen(item)}
						open={openObjectId === item.objectId}
						opened={() => (
							<div className={classes.opened}>
								{hasPoles(quotes) ? (
									<div
										className={classes.poleGroups}
										data-testid="curate-poles"
									>
										{(["A", "B"] as const).map((pole) => {
											const shown = quotesOfPole(item, quotes, pole);
											if (shown.length === 0) return null;
											return (
												<div key={pole}>
													<p className={classes.poleGroupHead}>
														{pole === "A" ? poleA : poleB}
													</p>
													<ul className={classes.quotes}>
														{shown.map((quote, index) => (
															// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
															<Quote key={index} quote={quote} />
														))}
													</ul>
												</div>
											);
										})}
									</div>
								) : (
									<ul className={classes.quotes}>
										{(quotes.length > 0
											? quotesOfPole(item, quotes, null)
											: curateQuotes(item)
										).map((quote, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
											<Quote key={index} quote={quote} />
										))}
									</ul>
								)}
								<p className={classes.resolve}>
									<span className={classes.resolveLabel}>
										<Trans>To resolve:</Trans>{" "}
									</span>
									{fieldWords(item, "toResolve")}
								</p>
								<CurateActions
									actions={shape.actions}
									analysisHref={shape.analysisHref}
									canEdit={shape.canEdit}
									item={item}
									projectId={shape.projectId}
								/>
							</div>
						)}
						testId={`curate-tension-${item.objectId}`}
					/>
				);
			})}
		</CurateTable>
	);
}
