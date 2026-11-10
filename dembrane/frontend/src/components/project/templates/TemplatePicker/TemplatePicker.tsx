import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useId } from "react";
import { SelectableCardGrid } from "@/components/common/SelectableCardGrid/SelectableCardGrid";
import {
	CARD_KEYS,
	TEMPLATE_ICONS,
	type TemplateKey,
	type TemplateSummary,
	templateFacts,
	templateName,
	templateWhen,
} from "../projectTemplates";
import { TemplateCard } from "../TemplateCard/TemplateCard";

interface TemplatePickerProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	/** The list could not load: the cards are left out and blank stays possible. */
	failed?: boolean;
	value: TemplateKey | null;
	onChange: (key: TemplateKey) => void;
	/** The quiet way out: a project with nothing set up. Hidden when not given. */
	onStartBlank?: () => void;
	/** Heading level: a step of a page is a 4, a group inside a section a 5. */
	order?: 4 | 5;
}

/**
 * "What are you going to do?": one card per template and a quiet "Start blank". Props in,
 * callbacks out; TemplatePickerConnected fetches the templates.
 */
export const TemplatePicker = ({
	templates,
	failed = false,
	value,
	onChange,
	onStartBlank,
	order = 4,
}: TemplatePickerProps) => {
	const headingId = useId();
	const byKey = new Map((templates ?? []).map((tpl) => [tpl.key, tpl]));
	const cards = CARD_KEYS.filter((key) => byKey.has(key));

	return (
		<Stack gap="md" data-testid="template-picker" data-tour="template-picker">
			<Stack gap="xs">
				<Title order={order} id={headingId}>
					<Trans>What are you going to do?</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						Pick the closest fit and dembrane sets the project up for it. You
						can change every setting later.
					</Trans>
				</Text>
			</Stack>

			{!templates && !failed ? (
				<Stack gap="sm" aria-busy="true" aria-label={t`Loading templates`}>
					{CARD_KEYS.map((key) => (
						<Skeleton key={key} height={112} />
					))}
				</Stack>
			) : failed ? (
				<Text size="sm" data-testid="template-picker-failed">
					<Trans>
						The templates did not load. You can still start blank and set it up
						yourself.
					</Trans>
				</Text>
			) : (
				<SelectableCardGrid
					labelId={headingId}
					name="project-template"
					value={value}
					onChange={(key) => onChange(key as TemplateKey)}
					testId="template-picker-grid"
					options={cards.map((key) => ({
						render: () => (
							<TemplateCard
								icon={TEMPLATE_ICONS[key]}
								name={templateName(key)}
								when={templateWhen(key)}
								facts={templateFacts(byKey.get(key) as TemplateSummary)}
							/>
						),
						testId: `template-card-${key}`,
						value: key,
					}))}
				/>
			)}

			{onStartBlank && (
				<Group gap="xs" align="baseline">
					<Button
						variant="subtle"
						size="sm"
						onClick={onStartBlank}
						data-testid="template-picker-start-blank"
					>
						<Trans>Start blank</Trans>
					</Button>
					<Text size="xs" c="dimmed">
						{templateWhen("blank")}
					</Text>
				</Group>
			)}
		</Stack>
	);
};
