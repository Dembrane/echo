import { Group, List, Stack, Text } from "@mantine/core";
import type { Icon } from "@phosphor-icons/react";

interface TemplateCardProps {
	icon: Icon;
	name: string;
	/** "Great for ...": who it is for, in one line. */
	greatFor: string;
	/** What it sets up: two or three short facts. */
	facts: readonly string[];
	/** Quiet labels: the verbs and the setup, then a named format if it follows one. */
	labels?: readonly string[];
	method?: string | null;
	testId?: string;
}

/**
 * The face of one template, scannable in two seconds: name, who it is for, what it sets up,
 * and quiet labels last. Holds no state and no button; SelectableCardGrid makes it a radio.
 */
export const TemplateCard = ({
	icon: IconComponent,
	name,
	greatFor,
	facts,
	labels = [],
	method,
	testId,
}: TemplateCardProps) => (
	<Stack gap="xs" {...(testId ? { "data-testid": testId } : {})}>
		<Group gap="xs" wrap="nowrap" align="center">
			<IconComponent size={24} aria-hidden />
			<Text size="lg" lh={1.25}>
				{name}
			</Text>
		</Group>
		<Text size="sm">{greatFor}</Text>
		{facts.length > 0 && (
			<List size="sm" spacing={2} className="app-muted">
				{facts.map((fact) => (
					<List.Item key={fact}>{fact}</List.Item>
				))}
			</List>
		)}
		{(labels.length > 0 || method) && (
			<Text size="xs" className="app-muted" data-testid="template-card-labels">
				{[...(method ? [method] : []), ...labels].join(" · ")}
			</Text>
		)}
	</Stack>
);
