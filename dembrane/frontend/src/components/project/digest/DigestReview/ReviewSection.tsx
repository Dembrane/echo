import { Collapse, Group, Stack, Switch, Text } from "@mantine/core";
import { type ReactNode, useId } from "react";
import { testId } from "@/lib/testUtils";
import type { DigestProvenance } from "../digest";
import { Provenance } from "./Provenance";

const RULE = "var(--app-stroke) solid var(--app-rule-color)";

interface ReviewSectionProps {
	id: string;
	title: string;
	/** What the section sets up, in one quiet line. */
	hint?: ReactNode;
	provenance?: DigestProvenance | null;
	/** Absent for parts that cannot be switched off (the name, the template). */
	on?: boolean;
	onToggle?: (on: boolean) => void;
	switchLabel?: string;
	children: ReactNode;
}

/**
 * One part of what dembrane understood: its title, where it came from, a switch to leave
 * it out, and the part itself, edited in place. Something to read, so a rule above it.
 */
export const ReviewSection = ({
	id,
	title,
	hint,
	provenance,
	on,
	onToggle,
	switchLabel,
	children,
}: ReviewSectionProps) => {
	const titleId = useId();
	const bodyId = useId();
	const switchable = on !== undefined && onToggle;
	const open = on ?? true;
	return (
		<Stack
			component="section"
			gap="xs"
			pt="md"
			aria-labelledby={titleId}
			style={{ borderTop: RULE }}
			data-tour={`project-digest-${id}`}
			{...testId(`project-digest-section-${id}`)}
		>
			<Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
				<Group
					gap="xs"
					wrap="wrap"
					align="center"
					style={{ flex: 1, minWidth: 0 }}
				>
					<Text component="h3" size="md" m={0} id={titleId}>
						{title}
					</Text>
					<Provenance provenance={provenance} id={id} />
				</Group>
				{switchable ? (
					<Switch
						size="sm"
						mt={4}
						checked={open}
						onChange={(e) => onToggle(e.currentTarget.checked)}
						aria-label={switchLabel ?? title}
						aria-controls={bodyId}
						{...testId(`project-digest-section-${id}-switch`)}
					/>
				) : null}
			</Group>
			{hint ? (
				<Text size="xs" className="app-muted">
					{hint}
				</Text>
			) : null}
			<Collapse in={open}>
				<div id={bodyId}>{children}</div>
			</Collapse>
		</Stack>
	);
};
