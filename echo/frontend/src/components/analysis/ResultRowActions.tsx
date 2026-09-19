import { t } from "@lingui/core/macro";
import { ActionIcon, Group, Tooltip } from "@mantine/core";
import {
	EyeIcon,
	EyeSlashIcon,
	PencilSimpleIcon,
	ThumbsDownIcon,
	ThumbsUpIcon,
} from "@phosphor-icons/react";

export type ResultVote = "up" | "down";

export type ResultRowActionsProps = {
	/** Opens the drawer: wording, evidence and history. */
	onEdit?: () => void;
	/** Whether this result is hidden from the presentation it is listed in. */
	hidden?: boolean;
	onToggleHidden?: () => void;
	vote?: ResultVote | null;
	onVote?: (vote: ResultVote) => void;
	/** Prefix for each icon's `data-testid`, e.g. `present-result-<id>`. */
	testIdPrefix?: string;
};

const ICON = 18;

/**
 * The actions on one row of results, as icons with their words in a tooltip.
 * Shared so every table of findings offers the same gestures in the same
 * place. An action without a handler is not shown.
 */
export function ResultRowActions({
	hidden = false,
	onEdit,
	onToggleHidden,
	onVote,
	testIdPrefix,
	vote,
}: ResultRowActionsProps) {
	const at = (name: string) =>
		testIdPrefix ? { "data-testid": `${testIdPrefix}-${name}` } : {};
	const hideLabel = hidden
		? t`Show in this presentation`
		: t`Hide from this presentation`;
	const editLabel = t`Edit wording, see evidence and history`;
	const upLabel = t`This is right`;
	const downLabel = t`This is wrong`;
	return (
		<Group gap={2} wrap="nowrap">
			{onEdit && (
				<Tooltip label={editLabel}>
					<ActionIcon
						variant="subtle"
						size="md"
						aria-label={editLabel}
						onClick={onEdit}
						{...at("edit")}
					>
						<PencilSimpleIcon size={ICON} />
					</ActionIcon>
				</Tooltip>
			)}
			{onToggleHidden && (
				<Tooltip label={hideLabel}>
					<ActionIcon
						variant="subtle"
						size="md"
						aria-label={hideLabel}
						onClick={onToggleHidden}
						{...at("hide")}
					>
						{hidden ? <EyeSlashIcon size={ICON} /> : <EyeIcon size={ICON} />}
					</ActionIcon>
				</Tooltip>
			)}
			{onVote && (
				<>
					<Tooltip label={upLabel}>
						<ActionIcon
							variant="subtle"
							size="md"
							aria-label={upLabel}
							onClick={() => onVote("up")}
							{...at("vote-up")}
						>
							<ThumbsUpIcon
								size={ICON}
								weight={vote === "up" ? "fill" : "regular"}
							/>
						</ActionIcon>
					</Tooltip>
					<Tooltip label={downLabel}>
						<ActionIcon
							variant="subtle"
							size="md"
							aria-label={downLabel}
							onClick={() => onVote("down")}
							{...at("vote-down")}
						>
							<ThumbsDownIcon
								size={ICON}
								weight={vote === "down" ? "fill" : "regular"}
							/>
						</ActionIcon>
					</Tooltip>
				</>
			)}
		</Group>
	);
}
