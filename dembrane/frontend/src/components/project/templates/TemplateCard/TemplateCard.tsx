import { useLingui } from "@lingui/react";
import { Badge, Group, Stack, Text } from "@mantine/core";
import type { CardKey } from "../projectTemplates";
import { TemplateIllustration } from "../TemplateIllustration/TemplateIllustration";

interface TemplateCardProps {
	template: CardKey;
	name: string;
	/** "Great for ...": the occasions, and what sets the format apart, in one line. */
	greatFor: string;
	/** Small tags: a named method, the verbs, the setup. */
	tags?: readonly string[];
	testId?: string;
}

/**
 * The face of one template (ECHO-1058), read in two seconds: the room seen from above, its
 * name, who it is for, and small tags last. Holds no state and no button; the row, the grid
 * and the review put it in one.
 */
export const TemplateCard = ({
	template,
	name,
	greatFor,
	tags = [],
	testId,
}: TemplateCardProps) => {
	// Long compound names (Keukentafelgesprek) break at a syllable, in the UI's language.
	const { i18n } = useLingui();
	return (
		<Stack gap="xs" {...(testId ? { "data-testid": testId } : {})}>
			<TemplateIllustration template={template} />
			<Text
				size="lg"
				lh={1.25}
				mt="xs"
				lang={i18n.locale}
				style={{ hyphens: "auto", overflowWrap: "break-word" }}
			>
				{name}
			</Text>
			<Text size="sm">{greatFor}</Text>
			{tags.length > 0 && (
				<Group gap={4} wrap="wrap" data-testid="template-card-tags">
					{tags.map((tag) => (
						<Badge key={tag} size="sm">
							{tag}
						</Badge>
					))}
				</Group>
			)}
		</Stack>
	);
};
