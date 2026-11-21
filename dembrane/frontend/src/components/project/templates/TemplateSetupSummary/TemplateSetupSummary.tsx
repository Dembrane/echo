import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Collapse, Group, Stack, Text } from "@mantine/core";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { type ReactNode, useId, useState } from "react";
import { type TemplateSummary, topicLabel } from "../projectTemplates";

interface TemplateSetupSummaryProps {
	template: TemplateSummary;
	/** Starts open (the harness and tests); a host opens it themselves. */
	defaultOpened?: boolean;
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
	<Group gap="md" align="flex-start" wrap="nowrap">
		<Text size="xs" className="app-muted" w={96} style={{ flexShrink: 0 }}>
			{label}
		</Text>
		<Text size="sm" style={{ flex: 1 }}>
			{children}
		</Text>
	</Group>
);

/**
 * "What this sets up" (ECHO-1053): every setting the template writes, and the host script
 * the host guide starts with, collapsed under one button so the host sees what they get
 * without having to read it. Everything can be changed after creating.
 */
export const TemplateSetupSummary = ({
	template,
	defaultOpened = false,
}: TemplateSetupSummaryProps) => {
	const [opened, setOpened] = useState(defaultOpened);
	const panelId = useId();
	const s = template.summary;
	const topics = (
		s.verification_topics.length ? s.verification_topics : ["agreements"]
	)
		.map(topicLabel)
		.join(", ");
	const explore =
		s.explore_mode === "brainstorm"
			? t`On, "What if" questions`
			: s.explore_mode === "custom"
				? t`On, your own question`
				: t`On, one question`;
	const tutorial =
		s.tutorial === "advanced"
			? t`Tips and best practices`
			: s.tutorial === "basic"
				? t`The essentials`
				: t`None`;
	const nameBox = !s.asks_for_name
		? t`None: nothing to fill in`
		: (s.name_label ?? t`Session name`);

	return (
		<Stack gap="xs" data-testid="template-setup-summary">
			<Button
				variant="subtle"
				size="sm"
				w="fit-content"
				leftSection={
					opened ? <CaretDownIcon size={16} /> : <CaretRightIcon size={16} />
				}
				aria-expanded={opened}
				aria-controls={panelId}
				onClick={() => setOpened((o) => !o)}
				data-testid="template-setup-summary-toggle"
			>
				<Trans>What this sets up</Trans>
			</Button>
			<Collapse in={opened}>
				<Stack
					gap="xs"
					id={panelId}
					pl="md"
					data-testid="template-setup-summary-panel"
				>
					<Row label={t`Verify`}>
						{s.verify ? (
							<>
								{topics}
								{s.verify_on_finish && (
									<Text span size="sm" className="app-muted">
										{" · "}
										<Trans>reminded before finishing</Trans>
									</Text>
								)}
							</>
						) : (
							<Trans>Off</Trans>
						)}
					</Row>
					<Row label={t`Explore`}>
						{s.explore ? explore : <Trans>Off</Trans>}
						{s.explore && (
							<Text span size="sm" className="app-muted">
								{" · "}
								{s.cross_pollination ? (
									<Trans>can bring in other groups</Trans>
								) : (
									<Trans>reads this conversation only</Trans>
								)}
							</Text>
						)}
					</Row>
					<Row label={t`Name box`}>{nameBox}</Row>
					<Row label={t`Tags`}>
						{s.tags.length ? s.tags.join(", ") : <Trans>None</Trans>}
					</Row>
					<Row label={t`Tutorial`}>{tutorial}</Row>
					<Row label={t`Titles`}>
						{s.auto_titles ? (
							<Trans>Each conversation gets a title</Trans>
						) : (
							<Trans>Off</Trans>
						)}
					</Row>
					{s.host_guide_title && (
						<Row label={t`Host script`}>
							<span data-testid="template-setup-summary-script">
								{s.host_guide_title}
							</span>
							<Text span size="sm" className="app-muted">
								{" · "}
								<Trans>in your host guide, ready to edit</Trans>
							</Text>
						</Row>
					)}
					<Text size="xs" className="app-muted">
						<Trans>You can change every setting after creating.</Trans>
					</Text>
				</Stack>
			</Collapse>
		</Stack>
	);
};
