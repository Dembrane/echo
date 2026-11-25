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
 * All formats' filters (ECHO-1053): what the host needs to do (the five verbs of the
 * use-cases page, its wording on hover), and how it is recorded. Toggle buttons: pressing
 * one on presses its neighbour in the row off; pressing it again clears it. Props in,
 * callbacks out.
 */
export const TemplateFilters = ({
	value,
	onChange,
	count,
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
			<Text
				size="xs"
				className="app-muted"
				aria-live="polite"
				data-testid="template-filter-count"
			>
				<Plural value={count} one="# template" other="# templates" />
			</Text>
		</Stack>
	);
};
