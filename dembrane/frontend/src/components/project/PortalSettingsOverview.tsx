import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Card,
	Group,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { PaintBrushIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { languageOptionsByIso639_1 } from "@/components/language/LanguagePicker";

interface PortalSettingsOverviewProps {
	/** The project. `undefined` while the project query is loading. */
	project: Project | undefined;
	/** Route base, e.g. `/w/:workspaceId/projects/:projectId`. */
	base: string;
}

// Drives both the loaded view and the loading skeleton. Titles and labels
// mirror the portal editor verbatim so hosts can find the matching option.
const SECTIONS = [
	{
		key: "basic",
		rowKeys: ["language", "name", "email"],
		title: <Trans>Basic settings</Trans>,
	},
	{
		key: "participant",
		rowKeys: ["explore", "verify"],
		title: <Trans>Participant features</Trans>,
	},
	{
		key: "advanced",
		rowKeys: ["anonymisation", "event_cta"],
		title: <Trans>Advanced settings</Trans>,
	},
] as const;

// The names come from the language picker so every supported language has a
// label here the moment it is added there. `multi` is the legacy stored value.
const languageLabel = (language: Project["language"]): string => {
	if (language === "multi") return t`Multiple languages`;
	const option = languageOptionsByIso639_1.find(
		(entry) => entry.value === language,
	);
	return option?.label ?? t`Not set`;
};

const StatusBadge = ({ on }: { on: boolean }) =>
	on ? (
		<Badge size="sm" variant="light" color="green">
			<Trans>On</Trans>
		</Badge>
	) : (
		<Badge size="sm" variant="light" color="gray">
			<Trans>Off</Trans>
		</Badge>
	);

const SettingRow = ({
	label,
	children,
}: {
	label: ReactNode;
	children: ReactNode;
}) => (
	<Group justify="space-between" align="center" wrap="nowrap">
		<Text size="sm">{label}</Text>
		{children}
	</Group>
);

const SettingSection = ({
	title,
	children,
}: {
	title: ReactNode;
	children: ReactNode;
}) => (
	<Stack gap="xs">
		<Title order={5}>{title}</Title>
		<Stack gap="xs">{children}</Stack>
	</Stack>
);

export const PortalSettingsOverview = ({
	project,
	base,
}: PortalSettingsOverviewProps) => {
	// A read-only summary; the QR to take part sits beside it on the overview.
	return (
		<Card withBorder p="md" w="100%">
			<Stack gap="md">
				<Title order={4}>
					<Trans>Portal settings</Trans>
				</Title>

				{project ? (
					<>
						<SettingSection title={SECTIONS[0].title}>
							<SettingRow label={<Trans>Language</Trans>}>
								<Text size="sm" c="dimmed">
									{languageLabel(project.language)}
								</Text>
							</SettingRow>
							<SettingRow label={<Trans>Ask for name?</Trans>}>
								<StatusBadge
									on={!!project.default_conversation_ask_for_participant_name}
								/>
							</SettingRow>
							<SettingRow label={<Trans>Ask for email?</Trans>}>
								<StatusBadge
									on={!!project.default_conversation_ask_for_participant_email}
								/>
							</SettingRow>
						</SettingSection>

						<SettingSection title={SECTIONS[1].title}>
							<SettingRow label={<Trans>Explore</Trans>}>
								<StatusBadge on={!!project.is_get_reply_enabled} />
							</SettingRow>
							<SettingRow label={<Trans>Verify</Trans>}>
								<StatusBadge on={!!project.is_verify_enabled} />
							</SettingRow>
						</SettingSection>

						<SettingSection title={SECTIONS[2].title}>
							<SettingRow label={<Trans>Anonymize transcripts</Trans>}>
								<StatusBadge on={!!project.anonymize_transcripts} />
							</SettingRow>
							<SettingRow label={<Trans>dembrane event invitation</Trans>}>
								<StatusBadge
									on={project.is_dembrane_event_cta_enabled !== false}
								/>
							</SettingRow>
						</SettingSection>
					</>
				) : (
					SECTIONS.map((section) => (
						<SettingSection key={section.key} title={section.title}>
							{section.rowKeys.map((rowKey) => (
								<Skeleton key={`${section.key}-${rowKey}`} height={20} />
							))}
						</SettingSection>
					))
				)}

				<Box>
					<Button
						component={I18nLink}
						to={`${base}/portal-editor`}
						leftSection={<PaintBrushIcon size={20} />}
					>
						<Trans>Portal editor</Trans>
					</Button>
				</Box>
			</Stack>
		</Card>
	);
};
