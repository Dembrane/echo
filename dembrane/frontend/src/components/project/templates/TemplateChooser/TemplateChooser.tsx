import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Stack, Text, Title } from "@mantine/core";
import { UploadSimpleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { linkLabel, linkLine, type TemplateSummary } from "../projectTemplates";

interface TemplateChooserProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	/** The list could not load: the filters and the upload link are left out; the cards
	 * (then Quick start alone) stay. */
	failed: boolean;
	/** The heading's id, for a card grid that is labelled by it. */
	headingId?: string;
	/** What shows while the list loads. */
	skeleton: ReactNode;
	/** The filters above the cards. */
	filters: ReactNode;
	/** No format fits the filters; Quick start still shows. */
	empty: boolean;
	/** The quiet link under the cards, hidden when not given. */
	onUpload?: () => void;
	testId: string;
	/** The cards, Quick start first. */
	children: ReactNode;
}

/**
 * All formats' frame: the heading (a group inside the create page, so a 5) and its lede,
 * the loading, failed and empty states, the filters, and the quiet link to upload
 * recordings. The cards are the child, shown in every state but loading, so Quick
 * start is always there. Props in, callbacks out.
 */
export const TemplateChooser = ({
	templates,
	failed,
	headingId,
	skeleton,
	filters,
	empty,
	onUpload,
	testId,
	children,
}: TemplateChooserProps) => (
	<Stack gap="lg" data-testid={testId}>
		<Stack gap="xs">
			<Title order={5} id={headingId}>
				<Trans>What are you going to do?</Trans>
			</Title>
			<Text size="sm" className="app-muted">
				<Trans>
					Pick the closest fit and dembrane sets the project up for it, with a
					host script for the room. You can change every setting later.
				</Trans>
			</Text>
		</Stack>

		{!templates && !failed ? (
			<Stack gap="sm" aria-busy="true" aria-label={t`Loading templates`}>
				{skeleton}
			</Stack>
		) : (
			<>
				{failed ? (
					<Text size="sm" data-testid="template-picker-failed">
						<Trans>
							The templates did not load. You can still use Quick start and set
							the project up yourself.
						</Trans>
					</Text>
				) : (
					<>
						{filters}
						{empty && (
							<Text size="sm" data-testid="template-picker-none">
								<Trans>
									No template fits both. Clear a filter, or use Quick start.
								</Trans>
							</Text>
						)}
					</>
				)}
				{children}
			</>
		)}

		{onUpload && !failed && (
			<Group
				gap="xs"
				align="baseline"
				wrap="wrap"
				data-testid="template-picker-links"
			>
				<Anchor
					component="button"
					type="button"
					size="sm"
					onClick={onUpload}
					data-testid="template-picker-upload"
				>
					<Group gap="xs" component="span" wrap="nowrap">
						<UploadSimpleIcon size={16} aria-hidden />
						{linkLabel("upload")}
					</Group>
				</Anchor>
				<Text size="xs" className="app-muted">
					{linkLine("upload")}
				</Text>
			</Group>
		)}
	</Stack>
);
