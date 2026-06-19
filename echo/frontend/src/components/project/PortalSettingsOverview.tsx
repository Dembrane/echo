import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Card,
	Divider,
	Flex,
	Group,
	Skeleton,
	Stack,
	Text,
} from "@mantine/core";
import { PaintBrushIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { ProjectQRCode } from "./ProjectQRCode";

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
		title: <Trans>Basic Settings</Trans>,
	},
	{
		key: "participant",
		rowKeys: ["explore", "verify"],
		title: <Trans>Participant Features</Trans>,
	},
	{
		key: "advanced",
		rowKeys: ["anonymisation"],
		title: <Trans>Advanced Settings</Trans>,
	},
] as const;

const languageLabel = (language: Project["language"]): string => {
	switch (language) {
		case "en":
			return t`English`;
		case "nl":
			return t`Dutch`;
		case "multi":
			return t`Multiple languages`;
		default:
			return t`Not set`;
	}
};

const StatusBadge = ({ on }: { on: boolean }) =>
	on ? (
		<Badge size="sm" variant="light" color="primary">
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
		<Text size="xs" c="dimmed" tt="uppercase">
			{title}
		</Text>
		<Stack gap="xs">{children}</Stack>
	</Stack>
);

export const PortalSettingsOverview = ({
	project,
	base,
}: PortalSettingsOverviewProps) => {
	const navigate = useI18nNavigate();

	return (
		<Card withBorder p="md" radius="sm" w="100%" maw={640}>
			<Stack gap="md">
				<Group justify="space-between" align="center" wrap="nowrap">
					<Text size="sm" fw={500}>
						<Trans>Portal Overview</Trans>
					</Text>
					<Button
						variant="subtle"
						size="xs"
						leftSection={<PaintBrushIcon size={16} />}
						onClick={() => navigate(`${base}/portal-editor`)}
					>
						<Trans>Edit</Trans>
					</Button>
				</Group>

				<Divider />

				<Flex
					direction={{ base: "column", md: "row" }}
					gap="lg"
					align="flex-start"
				>
					<Box w={{ base: "100%", md: 200 }} style={{ flexShrink: 0 }}>
						<ProjectQRCode project={project} />
					</Box>

					<Stack gap="md" style={{ flex: 1, minWidth: 0 }} w="100%">
						{project ? (
							<>
								<SettingSection title={SECTIONS[0].title}>
									<SettingRow label={<Trans>Language</Trans>}>
										<Text size="sm" c="dimmed">
											{languageLabel(project.language)}
										</Text>
									</SettingRow>
									<SettingRow label={<Trans>Ask for Name?</Trans>}>
										<StatusBadge
											on={
												!!project.default_conversation_ask_for_participant_name
											}
										/>
									</SettingRow>
									<SettingRow label={<Trans>Ask for Email?</Trans>}>
										<StatusBadge
											on={
												!!project.default_conversation_ask_for_participant_email
											}
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
									<SettingRow label={<Trans>Anonymize Transcripts</Trans>}>
										<StatusBadge on={!!project.anonymize_transcripts} />
									</SettingRow>
								</SettingSection>
							</>
						) : (
							SECTIONS.map((section) => (
								<SettingSection key={section.key} title={section.title}>
									{section.rowKeys.map((rowKey) => (
										<Skeleton
											key={`${section.key}-${rowKey}`}
											height={20}
											radius="sm"
										/>
									))}
								</SettingSection>
							))
						)}
					</Stack>
				</Flex>
			</Stack>
		</Card>
	);
};
