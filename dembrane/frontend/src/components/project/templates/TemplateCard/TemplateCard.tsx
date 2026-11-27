import { useLingui } from "@lingui/react";
import { Badge, Group, Stack, Text } from "@mantine/core";
import type { ChoiceKey } from "../projectTemplates";
import { TemplateIllustration } from "../TemplateIllustration/TemplateIllustration";

interface TemplateCardProps {
	template: ChoiceKey;
	name: string;
	/**
	 * "Great for ...": the occasions, and what sets the format apart, in one line. For
	 * Quick start, what it is.
	 */
	greatFor: string;
	/** Small tags: a named method, the verbs, the setup. */
	tags?: readonly string[];
	/** In the bar on the create page: the room and its name alone. */
	compact?: boolean;
	testId?: string;
}

/**
 * The face of one template (ECHO-1058), read in two seconds: the room seen from above, its
 * name, who it is for, and small tags last. Compact, in the bar on the create page, it is
 * the room and its name; who it is for is one press away, in all templates. Holds no state
 * and no button; the bar, the grid and the review put it in one.
 */
export const TemplateCard = ({
	template,
	name,
	greatFor,
	tags = [],
	compact = false,
	testId,
}: TemplateCardProps) => {
	// Long compound names (Keukentafelgesprek) break at a syllable, in the UI's language.
	const { i18n } = useLingui();
	return (
		<Stack gap="xs" {...(testId ? { "data-testid": testId } : {})}>
			<TemplateIllustration template={template} />
			<Text
				size={compact ? "sm" : "lg"}
				lh={1.25}
				mt={compact ? 0 : "xs"}
				lang={i18n.locale}
				style={{ hyphens: "auto", overflowWrap: "break-word" }}
			>
				{name}
			</Text>
			{!compact && <Text size="sm">{greatFor}</Text>}
			{!compact && tags.length > 0 && (
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
