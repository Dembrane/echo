import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Button, UnstyledButton } from "@mantine/core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { memo, type ReactNode, useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { ResultStage } from "@/components/results";
import { cn } from "@/lib/utils";
import { OBJECT_TYPE_STYLES } from "../attributes";
import type {
	EvidenceGroup,
	MapObjectInfo,
	StakeholderDetail,
} from "../data/adapter";
import {
	DERIVED_FROM,
	type RelatedObject,
	tensionSupport,
} from "../data/relations";
import type { MapGraphNode, ObjectType } from "../types";
import {
	basisLabel,
	CaptionText,
	mapVars,
	originLabel,
	relationLabel,
	rungLabel,
	TypeDot,
} from "./shared";

export type ConversationHref = (conversationId: string) => string | null;

/** What the inspector knows about the node beyond its label and quotes. */
export type NodeInspection = {
	object: MapObjectInfo | null;
	/** Explicit relations, including those to objects hidden by filters. */
	related: RelatedObject[];
	evidenceFor: (nodeId: string) => EvidenceGroup[];
	/** Selects a visible related object. */
	onSelect?: (nodeId: string) => void;
	/**
	 * Adds a hidden type to the Objects filter. The node budget still applies,
	 * so a reveal can lead to the over-budget state.
	 */
	onReveal?: (type: ObjectType) => void;
	/** Explicit mixed-object views may opt into revealing related types. */
	canRevealRelatedTypes?: boolean;
	/**
	 * False where the payload withholds provenance (the room's projection):
	 * the source line would otherwise state a default as if it were known.
	 */
	provenance?: boolean;
};

type NodeDetailCardProps = {
	node: MapGraphNode | null;
	/** Quotes per source conversation. */
	evidence: EvidenceGroup[];
	conversationHref?: ConversationHref;
	collapsibleQuotes?: boolean;
	inspection?: NodeInspection | null;
};

const QuoteGroups = ({
	evidence,
	conversationHref,
}: {
	evidence: EvidenceGroup[];
	conversationHref?: ConversationHref;
}) => (
	<div className="space-y-3">
		{evidence.map((group) => {
			const href = conversationHref?.(group.conversationId) ?? null;
			return (
				<div key={group.conversationId} className="space-y-1.5">
					{href ? (
						<Anchor
							component={I18nLink}
							to={href}
							size="xs"
							className="font-semibold uppercase tracking-wider"
						>
							{group.label}
						</Anchor>
					) : (
						<CaptionText className="font-semibold uppercase tracking-wider">
							{group.label}
						</CaptionText>
					)}
					{group.quotes.map((quote, index) => (
						<blockquote
							// Quotes repeat across arguments; position keeps them apart.
							// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
							key={index}
							className="border-l-2 pl-3 text-sm"
							style={{ borderColor: mapVars.border }}
						>
							{quote}
						</blockquote>
					))}
				</div>
			);
		})}
	</div>
);

const ConsolidationMembers = ({
	detail,
	conversationHref,
}: {
	detail: Extract<
		MapObjectInfo["detail"],
		{ type: "argument" | "deduplicated_argument" }
	>;
	conversationHref?: ConversationHref;
}) => {
	const consolidation = detail.consolidation;
	if (!consolidation) return null;
	return (
		<Section
			title={<Trans>Combined from {consolidation.memberCount} arguments</Trans>}
		>
			{consolidation.members.length > 0 ? (
				<ol className="space-y-3" data-testid="consolidation-members">
					{consolidation.members.map((member, index) => (
						<li
							key={member.objectId}
							className="space-y-1 text-sm leading-snug"
						>
							<p>
								{index + 1}.{" "}
								{member.statement || t`Source statement unavailable`}
							</p>
							{member.evidence.length > 0 && (
								<div className="pl-4">
									<QuoteGroups
										evidence={member.evidence}
										conversationHref={conversationHref}
									/>
								</div>
							)}
						</li>
					))}
				</ol>
			) : (
				<CaptionText>
					<Trans>
						The original statements are unavailable for this older result.
					</Trans>
				</CaptionText>
			)}
		</Section>
	);
};

const Section = ({
	title,
	children,
}: {
	title: ReactNode;
	children: ReactNode;
}) => (
	<div className="space-y-1">
		<p className="text-xs uppercase tracking-wider">{title}</p>
		{children}
	</div>
);

/** One related object: selectable when visible, revealable when hidden. */
const RelatedItem = ({
	item,
	inspection,
	conversationHref,
	withEvidence,
}: {
	item: RelatedObject;
	inspection: NodeInspection;
	conversationHref?: ConversationHref;
	withEvidence?: boolean;
}) => {
	const label = item.label ?? t`An object outside this view`;
	const type = item.type;
	const typePlural = type ? OBJECT_TYPE_STYLES[type].pluralLabel() : "";
	const evidence =
		withEvidence && item.node ? inspection.evidenceFor(item.otherId) : [];
	return (
		<li className="space-y-1">
			<div className="flex items-start gap-2">
				{type && (
					<span className="mt-1.5">
						<TypeDot type={type} />
					</span>
				)}
				<div className="min-w-0 flex-1 space-y-0.5">
					{item.visible && inspection.onSelect ? (
						<UnstyledButton
							onClick={() => inspection.onSelect?.(item.otherId)}
							className="text-left text-sm leading-snug transition-opacity hover:opacity-80"
						>
							{label}
						</UnstyledButton>
					) : (
						<p className="text-sm leading-snug">{label}</p>
					)}
					<CaptionText>
						{relationLabel(item.relation.type)} ·{" "}
						{basisLabel(item.relation.basis)}
					</CaptionText>
					{!item.visible && (
						<div className="flex flex-wrap items-center gap-2">
							<CaptionText>
								{item.node && inspection.canRevealRelatedTypes ? (
									<Trans>Hidden by the Objects filter</Trans>
								) : (
									<Trans>Not in this view</Trans>
								)}
							</CaptionText>
							{type &&
								inspection.canRevealRelatedTypes &&
								inspection.onReveal && (
									<Button
										size="compact-xs"
										variant="subtle"
										radius={0}
										onClick={() => inspection.onReveal?.(type)}
									>
										<Trans>Show {typePlural}</Trans>
									</Button>
								)}
						</div>
					)}
				</div>
			</div>
			{evidence.length > 0 && (
				<div className="pl-5">
					<QuoteGroups
						evidence={evidence}
						conversationHref={conversationHref}
					/>
				</div>
			)}
		</li>
	);
};

const RelatedList = ({
	items,
	inspection,
	conversationHref,
	withEvidence,
	empty,
}: {
	items: RelatedObject[];
	inspection: NodeInspection;
	conversationHref?: ConversationHref;
	withEvidence?: boolean;
	empty?: ReactNode;
}) =>
	items.length === 0 ? (
		empty ? (
			<CaptionText>{empty}</CaptionText>
		) : null
	) : (
		<ul className="space-y-2">
			{items.map((item) => (
				<RelatedItem
					key={item.relation.id}
					item={item}
					inspection={inspection}
					conversationHref={conversationHref}
					withEvidence={withEvidence}
				/>
			))}
		</ul>
	);

const TensionSections = ({
	inspection,
	conversationHref,
}: {
	inspection: NodeInspection;
	conversationHref?: ConversationHref;
}) => {
	const support = tensionSupport(inspection.related);
	return (
		<div className="space-y-3" data-testid="tension-inspector">
			<Section title={<Trans>Supporting pole A</Trans>}>
				<RelatedList
					items={support.poleA}
					inspection={inspection}
					conversationHref={conversationHref}
					withEvidence
					empty={<Trans>No linked arguments.</Trans>}
				/>
			</Section>
			<Section title={<Trans>Supporting pole B</Trans>}>
				<RelatedList
					items={support.poleB}
					inspection={inspection}
					conversationHref={conversationHref}
					withEvidence
					empty={<Trans>No linked arguments.</Trans>}
				/>
			</Section>
			{support.other.length > 0 && (
				<Section title={<Trans>Relationships</Trans>}>
					<RelatedList items={support.other} inspection={inspection} />
				</Section>
			)}
		</div>
	);
};

const StakeholderSections = ({
	detail,
	inspection,
}: {
	detail: StakeholderDetail;
	inspection: NodeInspection;
}) => (
	<div className="space-y-3" data-testid="stakeholder-inspector">
		<Section title={<Trans>Evidence</Trans>}>
			<p className="text-sm">
				{rungLabel(detail.rung)}
				{detail.invokedBy ? ` · ${detail.invokedBy}` : ""}
			</p>
		</Section>
		<Section title={<Trans>Evidenced connections</Trans>}>
			<RelatedList
				items={inspection.related}
				inspection={inspection}
				empty={<Trans>No evidenced connections.</Trans>}
			/>
		</Section>
	</div>
);

const Provenance = ({ object }: { object: MapObjectInfo }) => {
	const { provenance } = object;
	const recipe = [provenance.recipeId, provenance.recipeVersion]
		.filter(Boolean)
		.join(" · ");
	const origin = originLabel(provenance);
	const argument =
		object.type === "argument" || object.type === "deduplicated_argument";
	return (
		<div
			className="space-y-1 border-t pt-2"
			style={{ borderColor: mapVars.border }}
			data-testid="provenance"
		>
			<CaptionText>
				<Trans>Source: {origin}</Trans>
			</CaptionText>
			{!argument && (
				<>
					<CaptionText>
						{recipe ? (
							<Trans>Recipe: {recipe}</Trans>
						) : (
							<Trans>Recipe: not recorded</Trans>
						)}
					</CaptionText>
					{/* TODO(lead): link the revision history once its route exists. */}
					<CaptionText>
						<Trans>Revision history is not available yet.</Trans>
					</CaptionText>
				</>
			)}
		</div>
	);
};

/**
 * The statement of a node with its evidence, grouped by conversation, and
 * what its type adds: poles and support for a tension, role and stake for a
 * stakeholder, members for a deduplicated argument. Selecting in here never
 * changes the filters.
 */
export const NodeDetailCard = memo(function NodeDetailCard({
	node,
	evidence,
	conversationHref,
	collapsibleQuotes = false,
	inspection = null,
}: NodeDetailCardProps) {
	const [quotesOpen, setQuotesOpen] = useState(false);

	if (!node) {
		return (
			<CaptionText>
				<Trans>No node selected.</Trans>
			</CaptionText>
		);
	}

	const quoteCount = evidence.reduce(
		(total, group) => total + group.quotes.length,
		0,
	);
	const type = node.metadata.objectType;
	const object = inspection?.object ?? null;
	const detail = object?.detail;
	// Tensions and stakeholders list their relations in their own sections.
	const argumentDetail =
		detail?.type === "argument" || detail?.type === "deduplicated_argument"
			? detail
			: null;
	const otherRelations =
		inspection && type !== "tension" && type !== "stakeholder"
			? inspection.related.filter(
					(item) =>
						!argumentDetail?.consolidation ||
						item.relation.type !== DERIVED_FROM,
				)
			: [];
	const typeLabel =
		type === "argument" || type === "deduplicated_argument"
			? t`Argument`
			: OBJECT_TYPE_STYLES[type]?.label();

	return (
		<div className="space-y-3">
			{type && (
				<p className="flex items-center gap-2 text-xs uppercase tracking-wider">
					<TypeDot
						type={
							type === "argument" || type === "deduplicated_argument"
								? "argument"
								: type
						}
					/>
					{typeLabel}
				</p>
			)}
			{/* The finding in its kind's shape, the way a room would get it. The
			    map keeps its own evidence below, attributed and linked, because
			    the stage's quotes are unattributed and the audience payload
			    carries none at all. */}
			<ResultStage
				item={{
					detail: object?.detail,
					label: node.label ?? node.id,
					type: type ?? "argument",
				}}
				quotes={[]}
				evidence={{ conversations: evidence.length, quotes: quoteCount }}
			/>

			{inspection && detail?.type === "tension" && (
				<TensionSections
					inspection={inspection}
					conversationHref={conversationHref}
				/>
			)}
			{inspection && detail?.type === "stakeholder" && (
				<StakeholderSections detail={detail} inspection={inspection} />
			)}
			{argumentDetail && (
				<ConsolidationMembers
					detail={argumentDetail}
					conversationHref={conversationHref}
				/>
			)}

			{detail?.type === "popcorn" && quoteCount > 0 && (
				<p className="text-xs uppercase tracking-wider">
					<Trans>Source evidence</Trans>
				</p>
			)}
			{quoteCount > 0 && !collapsibleQuotes && (
				<QuoteGroups evidence={evidence} conversationHref={conversationHref} />
			)}
			{quoteCount > 0 && collapsibleQuotes && (
				<div>
					<UnstyledButton
						onClick={() => setQuotesOpen((open) => !open)}
						aria-expanded={quotesOpen}
						className="flex items-center gap-1 text-xs uppercase tracking-wider transition-opacity hover:opacity-80"
					>
						<CaretRightIcon
							size={12}
							className={cn("transition-transform", quotesOpen && "rotate-90")}
						/>
						<Trans>Quotes ({quoteCount})</Trans>
					</UnstyledButton>
					{quotesOpen && (
						<div className="mt-2">
							<QuoteGroups
								evidence={evidence}
								conversationHref={conversationHref}
							/>
						</div>
					)}
				</div>
			)}

			{inspection && otherRelations.length > 0 && (
				<Section title={<Trans>Relationships</Trans>}>
					<RelatedList items={otherRelations} inspection={inspection} />
				</Section>
			)}

			{object && inspection?.provenance !== false && (
				<Provenance object={object} />
			)}
		</div>
	);
});
