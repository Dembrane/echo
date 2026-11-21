import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Group, Stack, Text, Tooltip, VisuallyHidden } from "@mantine/core";
import { useId } from "react";
import {
	SETUPS,
	type Setup,
	setupLabel,
	type TemplateFilter,
	VERBS,
	type Verb,
	verbHint,
	verbLabel,
} from "../projectTemplates";

interface TemplateFiltersProps {
	value: TemplateFilter;
	onChange: (next: TemplateFilter, changed: "verb" | "setup") => void;
	/** How many cards the current view shows, said politely to a screen reader. */
	count: number;
	/**
	 * The "Show all" toggle, where the view starts with the most used cards (the picker):
	 * `on` when every card is shown. Left out where every card already shows (all formats):
	 * then only the count.
	 */
	showAll?: { on: boolean; onChange: (on: boolean) => void };
}

const FilterButton = ({
	label,
	hint,
	pressed,
	onClick,
	testId,
}: {
	label: string;
	hint?: string;
	pressed: boolean;
	onClick: () => void;
	testId: string;
}) => {
	const hintId = useId();
	const button = (
		<button
			type="button"
			className="app-filter"
			aria-pressed={pressed}
			aria-describedby={hint ? hintId : undefined}
			onClick={onClick}
			data-testid={testId}
		>
			{label}
			{hint && <VisuallyHidden id={hintId}>{hint}</VisuallyHidden>}
		</button>
	);
	return hint ? (
		<Tooltip label={hint} openDelay={300} withinPortal>
			{button}
		</Tooltip>
	) : (
		button
	);
};

/**
 * The picker's filters (ECHO-1053): what the host needs to do (the five verbs of the
 * use-cases page, its wording on hover), and how it is recorded. Toggle buttons: pressing
 * one on presses its neighbour in the row off; pressing it again clears it. "Show all"
 * clears both and shows every card. Props in, callbacks out.
 */
export const TemplateFilters = ({
	value,
	onChange,
	count,
	showAll,
}: TemplateFiltersProps) => {
	const verbsId = useId();
	const setupId = useId();
	const toggleVerb = (verb: Verb) =>
		onChange({ ...value, verb: value.verb === verb ? null : verb }, "verb");
	const toggleSetup = (setup: Setup) =>
		onChange(
			{ ...value, setup: value.setup === setup ? null : setup },
			"setup",
		);
	const filtering = value.verb !== null || value.setup !== null;

	return (
		<Stack gap="sm" data-testid="template-filters">
			<Group gap="lg" align="flex-end" wrap="wrap">
				<Stack gap={4}>
					<Text size="xs" className="app-muted" id={verbsId}>
						<Trans>What do you need to do?</Trans>
					</Text>
					<Group
						role="group"
						aria-labelledby={verbsId}
						className="app-filter-row"
						wrap="wrap"
					>
						{VERBS.map((verb) => (
							<FilterButton
								key={verb}
								label={verbLabel(verb)}
								hint={verbHint(verb)}
								pressed={value.verb === verb}
								onClick={() => toggleVerb(verb)}
								testId={`template-filter-verb-${verb}`}
							/>
						))}
					</Group>
				</Stack>
				<Stack gap={4}>
					<Text size="xs" className="app-muted" id={setupId}>
						<Trans>How is it recorded?</Trans>
					</Text>
					<Group
						role="group"
						aria-labelledby={setupId}
						className="app-filter-row"
						wrap="wrap"
					>
						{SETUPS.map((setup) => (
							<FilterButton
								key={setup}
								label={setupLabel(setup)}
								pressed={value.setup === setup}
								onClick={() => toggleSetup(setup)}
								testId={`template-filter-setup-${setup}`}
							/>
						))}
					</Group>
				</Stack>
			</Group>
			<Group gap="sm" align="center" wrap="nowrap">
				{showAll && (
					<FilterButton
						label={t`Show all`}
						pressed={showAll.on && !filtering}
						onClick={() => showAll.onChange(!(showAll.on && !filtering))}
						testId="template-filter-show-all"
					/>
				)}

				<Text
					size="xs"
					className="app-muted"
					aria-live="polite"
					data-testid="template-filter-count"
				>
					{filtering || !showAll || showAll.on ? (
						<Plural value={count} one="# template" other="# templates" />
					) : (
						<Trans>Most used. Filter to find more.</Trans>
					)}
				</Text>
			</Group>
		</Stack>
	);
};
