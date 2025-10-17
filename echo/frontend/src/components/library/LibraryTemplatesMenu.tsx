import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, Pill, Stack, Text } from "@mantine/core";
import { IconNotes } from "@tabler/icons-react";

// all this function does is that if someone clicks on a template, it will set the input to the template content
export const LibraryTemplatesMenu = ({
	onTemplateSelect,
}: {
	onTemplateSelect: ({
		query,
		additionalContext,
		key,
	}: {
		query: string;
		additionalContext: string;
		key: string;
	}) => void;
}) => {
	const templates = [
		{
			additionalContext: t`Identify recurring themes, topics, and arguments that appear consistently across conversations. Analyze their frequency, intensity, and consistency. Expected output: 3-7 aspects for small datasets, 5-12 for medium datasets, 8-15 for large datasets. Processing guidance: Focus on distinct patterns that emerge across multiple conversations.`,
			icon: IconNotes,
			query: t`Provide an overview of the main topics and recurring themes`,
			title: t`Recurring Themes`,
		},
	];

	return (
		<Stack>
			<Group align="flex-start">
				<Text size="sm" fw={500}>
					<Trans>Suggested:</Trans>
				</Text>
				{templates.map((t) => (
					// no translations for now
					<Pill
						component="button"
						key={t.title}
						variant="default"
						bg="transparent"
						className="border"
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							onTemplateSelect({
								additionalContext: t.additionalContext,
								key: t.title,
								query: t.query,
							});
						}}
					>
						<Text size="sm">{t.title}</Text>
					</Pill>
				))}
			</Group>
		</Stack>
	);
};
