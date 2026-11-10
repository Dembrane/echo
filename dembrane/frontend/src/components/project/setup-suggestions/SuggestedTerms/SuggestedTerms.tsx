import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Group,
	Stack,
	Text,
	Tooltip,
	VisuallyHidden,
} from "@mantine/core";
import { CheckIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { testId } from "@/lib/testUtils";
import {
	MAX_KEY_TERMS,
	NEAR_CAP,
	type ProposedTerm,
} from "../setupSuggestions";

interface SuggestedTermsProps {
	terms: readonly ProposedTerm[];
	/** Whether a proposed term is already in the project's key terms. */
	isAccepted: (term: string) => boolean;
	/** Key terms the project holds now, accepted ones included. */
	total: number;
	onToggle: (term: string) => void;
	onRemove: (term: string) => void;
	onAcceptAll: () => void;
}

/**
 * The proposed key terms as chips. Each chip is a toggle button: pressed means the term
 * is in the project's key terms. Its reason shows on hover and focus, and is read out with
 * the chip. The cross takes a proposal away. Props in, callbacks out.
 */
export const SuggestedTerms = ({
	terms,
	isAccepted,
	total,
	onToggle,
	onRemove,
	onAcceptAll,
}: SuggestedTermsProps) => {
	const baseId = useId();
	const atCap = total >= MAX_KEY_TERMS;
	const waiting = terms.filter((term) => !isAccepted(term.term));
	const count = total;
	const max = MAX_KEY_TERMS;

	return (
		<Stack gap="sm" {...testId("setup-suggestions-terms")}>
			<Group justify="space-between" gap="xs" wrap="wrap">
				<Text size="sm" component="h4" m={0}>
					<Trans>Key terms to add</Trans>
				</Text>
				<Button
					variant="subtle"
					size="xs"
					disabled={waiting.length === 0 || atCap}
					onClick={onAcceptAll}
					{...testId("setup-suggestions-accept-all")}
				>
					<Trans>Accept all</Trans>
				</Button>
			</Group>
			<Group gap="xs" component="ul" className="m-0 list-none p-0">
				{terms.map((term, i) => {
					const accepted = isAccepted(term.term);
					const reasonId = `${baseId}-reason-${i}`;
					const label = term.term;
					return (
						<Group
							key={term.term}
							gap="xs"
							wrap="nowrap"
							component="li"
							{...testId(`setup-suggestions-term-${i}`)}
						>
							<Tooltip
								label={term.reason}
								disabled={!term.reason}
								events={{ focus: true, hover: true, touch: true }}
								multiline
								maw={280}
								withArrow
							>
								<Button
									size="xs"
									// A chip is pressed like a checked filter: the blue box on
									// the action tint, never the primary pill.
									variant="outline"
									style={
										accepted
											? {
													background: "var(--app-action-tint)",
													borderColor: "var(--app-action)",
												}
											: undefined
									}
									aria-pressed={accepted}
									aria-describedby={term.reason ? reasonId : undefined}
									disabled={!accepted && atCap}
									leftSection={
										accepted ? (
											<CheckIcon size={16} aria-hidden />
										) : (
											<PlusIcon size={16} aria-hidden />
										)
									}
									onClick={() => onToggle(term.term)}
									styles={{ label: { textTransform: "none" } }}
									{...testId(`setup-suggestions-term-toggle-${i}`)}
								>
									{label}
								</Button>
							</Tooltip>
							{term.reason ? (
								<VisuallyHidden id={reasonId}>{term.reason}</VisuallyHidden>
							) : null}
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								aria-label={t`Remove ${label} from the suggestions`}
								onClick={() => onRemove(term.term)}
								{...testId(`setup-suggestions-term-remove-${i}`)}
							>
								<XIcon size={16} aria-hidden />
							</ActionIcon>
						</Group>
					);
				})}
			</Group>
			{count >= NEAR_CAP ? (
				<Text size="xs" c="dimmed" {...testId("setup-suggestions-cap")}>
					{atCap ? (
						<Trans>
							{count} of {max} key terms. That is the most a project holds:
							remove one to add another.
						</Trans>
					) : (
						<Trans>
							{count} of {max} key terms
						</Trans>
					)}
				</Text>
			) : null}
		</Stack>
	);
};
