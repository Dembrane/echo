import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	conversationWords,
	evidenceGroups,
	evidenceWords,
	fieldWords,
	hasPoles,
	type PoleQuote,
	resultEvidence,
	tensionQuotes,
} from "../resultContent";
import { EditableWords, useWordsEdit } from "../resultEditing";
import {
	attentionPhrase,
	HideControl,
	QuietLine,
	WordsStep,
} from "./CurateMeta";
import {
	CurateActions,
	type CurateQuote,
	curateQuotes,
	Quote,
} from "./CurateOpen";
import classes from "./curate.module.css";
import type { ShapeProps } from "./shape";
import { useHide } from "./useHide";

/**
 * The name of the conversation a quote came from, where the payload carries
 * one. A tension's quotes keep only the conversation's id, so the name is
 * there when the whole tension rests on a single conversation and the server
 * named it, and absent otherwise: an id is not a name and is not shown.
 */
function quotesOfPole(
	item: AnalysisObject,
	quotes: PoleQuote[],
	pole: "A" | "B" | null,
): CurateQuote[] {
	return quotes
		.filter((quote) => quote.pole === pole)
		.map((quote) => ({
			text: quote.text,
			where: conversationWords(item),
		}));
}

function TensionCard({
	actions,
	analysisHref,
	canEdit,
	item,
	projectId,
}: ShapeProps & { item: AnalysisObject }) {
	const hide = useHide({ actions, objectId: item.objectId });
	const edit = useWordsEdit({ actions: canEdit ? actions : null, item });
	const quotes = tensionQuotes(item);
	const poled = hasPoles(quotes);
	const groups = evidenceGroups(item);
	const evidence = resultEvidence(item);
	const poleA = fieldWords(item, "poleA");
	const poleB = fieldWords(item, "poleB");

	return (
		<li className={classes.card} data-held={hide.held || undefined}>
			<div className={classes.cardWords}>
				{/* Both poles on one line, the arrows travelling with the second so
				    a tension that wraps never leaves the glyph hanging. */}
				<p className={classes.poles}>
					<EditableWords
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
						<EditableWords
							edit={edit}
							field="poleB"
							label={t`The other side of this tension`}
							words={poleB}
						/>
					</span>
				</p>
				<p className={classes.knot}>
					<EditableWords
						edit={edit}
						field="knot"
						label={t`What this tension is about`}
						words={fieldWords(item, "knot")}
					/>
				</p>
				<p className={classes.resolve}>
					<span className={classes.resolveLabel}>
						<Trans>To resolve:</Trans>{" "}
					</span>
					<EditableWords
						edit={edit}
						field="toResolve"
						label={t`What would resolve this tension`}
						words={fieldWords(item, "toResolve")}
					/>
				</p>
			</div>

			<WordsStep edit={edit} objectId={item.objectId} />

			{/* A tension is few and rich: its evidence is on the card, never
			    behind a caret. Under each pole where the payload says which pole a
			    quote stands for; in one list where it does not. */}
			{poled ? (
				<div className={classes.poleGroups} data-testid="curate-poles">
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
						: curateQuotes(item, groups)
					).map((quote, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
						<Quote key={index} quote={quote} />
					))}
				</ul>
			)}

			<div className={classes.cardFoot}>
				<span>{evidenceWords(evidence, item.conversationName)}</span>
				<div className={classes.footActions}>
					<HideControl hide={hide} />
					{/* The card already shows the evidence, so the foot opens only
					    what is left: withdrawing, Analysis, and the workbench. */}
					<CurateActions
						actions={actions}
						analysisHref={analysisHref}
						canEdit={canEdit}
						item={item}
						projectId={projectId}
					/>
				</div>
			</div>
			<QuietLine
				actions={actions}
				hide={hide}
				lead={attentionPhrase(item)}
				objectId={item.objectId}
			/>
		</li>
	);
}

/**
 * The tensions tab: no list, no accordion. There are a handful of them and
 * each is rich, so every one is an open card, stacked, at a measure a host can
 * read a paragraph in.
 */
export function TensionsTab({
	items,
	...shape
}: ShapeProps & { items: AnalysisObject[] }) {
	return (
		<ul className={classes.cards} data-testid="curate-tensions">
			{items.map((item) => (
				<TensionCard {...shape} item={item} key={item.objectId} />
			))}
		</ul>
	);
}
