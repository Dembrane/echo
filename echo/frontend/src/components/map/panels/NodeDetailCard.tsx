import { Trans } from "@lingui/react/macro";
import { Anchor, UnstyledButton } from "@mantine/core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { memo, useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { cn } from "@/lib/utils";
import type { EvidenceGroup } from "../data/adapter";
import type { MapGraphNode } from "../types";
import { CaptionText, mapVars } from "./shared";

export type ConversationHref = (conversationId: string) => string | null;

type NodeDetailCardProps = {
	node: MapGraphNode | null;
	/** Quotes per source conversation. */
	evidence: EvidenceGroup[];
	conversationHref?: ConversationHref;
	titleSize?: "small" | "large";
	collapsibleQuotes?: boolean;
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

/** The statement of a node with its evidence, grouped by conversation. */
export const NodeDetailCard = memo(function NodeDetailCard({
	node,
	evidence,
	conversationHref,
	titleSize = "large",
	collapsibleQuotes = false,
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
	const titleClass =
		titleSize === "large"
			? "text-lg font-medium leading-tight"
			: "text-base font-medium leading-snug";

	return (
		<div className="space-y-3">
			<p className={titleClass}>{node.label ?? node.id}</p>
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
		</div>
	);
});
