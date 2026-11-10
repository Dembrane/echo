import { Group, List, Stack, Text } from "@mantine/core";
import type { Icon } from "@phosphor-icons/react";

interface TemplateCardProps {
	icon: Icon;
	name: string;
	when: string;
	/** What it sets up: two or three short facts. */
	facts: readonly string[];
	testId?: string;
}

/**
 * The face of one template: what it is called, when to pick it and what it sets up.
 * Holds no state and no button; SelectableCardGrid makes it a radio.
 */
export const TemplateCard = ({
	icon: IconComponent,
	name,
	when,
	facts,
	testId,
}: TemplateCardProps) => (
	<Stack gap="xs" {...(testId ? { "data-testid": testId } : {})}>
		<Group gap="xs" wrap="nowrap" align="center">
			<IconComponent size={20} aria-hidden />
			<Text size="lg">{name}</Text>
		</Group>
		<Text size="sm">{when}</Text>
		{facts.length > 0 && (
			<List size="sm" spacing={4} c="dimmed" className="app-muted">
				{facts.map((fact) => (
					<List.Item key={fact}>{fact}</List.Item>
				))}
			</List>
		)}
	</Stack>
);
