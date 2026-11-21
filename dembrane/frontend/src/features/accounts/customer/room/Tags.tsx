import { t } from "@lingui/core/macro";
import { Badge, Group, Tooltip } from "@mantine/core";
import { SignatureIcon } from "@phosphor-icons/react";
import { I18nLink } from "@/components/common/i18nLink";
import type { RoomLabelT } from "../../contract/contract.gen";
import { DpaHint, openDpaHint } from "../../DpaHint";
import { labelText, signText } from "./copy";
import { inLabelOrder, type SignKind } from "./model";
import classes from "./Tags.module.css";

/**
 * What one person does: signing first (the markers), then their labels in the contract's
 * order, then their own words for Other. No label says nothing: a row without any is
 * someone kept informed, and that needs no tag.
 */
export function PersonTags({
	labels,
	other,
	signs,
	signHref,
}: {
	labels: readonly RoomLabelT[];
	other: string | null;
	signs: readonly SignKind[];
	/** Where a signing marker's document opens; none draws it without a link. */
	signHref?: (kind: SignKind) => string | null;
}) {
	const own = other?.trim() ?? "";
	if (!signs.length && !labels.length && !own) return null;
	return (
		<Group gap="xs">
			{signs.map((k) => (
				<SignMarker key={k} kind={k} href={signHref?.(k) ?? null} />
			))}
			{inLabelOrder(labels).map((l) => (
				<Badge key={l} color="gray" data-label={l} className={classes.tag}>
					{labelText(l)}
				</Badge>
			))}
			{own && (
				<Badge color="gray" data-label="other" className={classes.tag}>
					{own}
				</Badge>
			)}
		</Group>
	);
}

/** Who signs a document: a fixed duty, never a label. Opens the document when it can. */
export function SignMarker({
	kind,
	href = null,
}: {
	kind: SignKind;
	href?: string | null;
}) {
	const props = {
		className: `${classes.tag} ${classes.sign}`,
		"data-sign": kind,
		leftSection: <SignatureIcon size={16} aria-hidden />,
		variant: "outline" as const,
	};
	if (!href) {
		const marker = <Badge {...props}>{signText(kind)}</Badge>;
		return kind === "dpa" ? <DpaHint>{marker}</DpaHint> : marker;
	}
	const hint = kind === "dpa" ? openDpaHint() : t`Open the offer`;
	return (
		<Tooltip label={hint}>
			<Badge
				{...props}
				component={I18nLink}
				to={href}
				aria-label={`${signText(kind)}. ${hint}`}
			>
				{signText(kind)}
			</Badge>
		</Tooltip>
	);
}
