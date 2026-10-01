import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Avatar,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconExternalLink, IconPinFilled } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import { useParams } from "react-router";
import { Icons } from "@/icons";
import { avatarUrl } from "@/lib/avatar";
import { testId } from "@/lib/testUtils";
import { formatDurationFromHours } from "@/lib/time";
import { I18nLink } from "../common/i18nLink";

function AccessBubbles({ project }: { project: Project }) {
	const preview = (
		project as unknown as {
			access_preview?: Array<{
				display_name: string;
				avatar: string | null;
			}>;
			access_count?: number;
		}
	).access_preview;
	const count =
		(project as unknown as { access_count?: number }).access_count ??
		preview?.length ??
		0;

	if (!preview) return null;
	if (preview.length === 0) {
		return (
			<Avatar size="sm" radius="xl" color="gray" aria-label={t`No one shared yet`}>
				?
			</Avatar>
		);
	}

	const shown = preview.slice(0, 3);
	const overflow = Math.max(0, count - shown.length);
	const visibleNames = shown.map((p) => p.display_name).filter(Boolean);
	const tooltipLabel =
		overflow > 0
			? t`Shared with ${visibleNames.join(", ")} and ${overflow} others`
			: t`Shared with ${visibleNames.join(", ")}`;

	return (
		<Tooltip label={tooltipLabel} withArrow>
			<Avatar.Group
				spacing="sm"
				role="group"
				aria-label={t`People with access`}
			>
				{shown.map((p, i) => (
					<Avatar
						key={`${p.display_name}-${i}`}
						size="sm"
						radius="xl"
						src={avatarUrl(p.avatar, 48)}
						aria-label={p.display_name || t`Unknown`}
					>
						{(p.display_name || "?").slice(0, 2).toUpperCase()}
					</Avatar>
				))}
				{overflow > 0 && (
					<Avatar
						size="sm"
						radius="xl"
						color="blue"
						aria-label={t`${overflow} more people`}
					>
						+{overflow}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip>
	);
}

const LANGUAGE_LABELS: Record<string, string> = {
	de: "DE",
	en: "EN",
	es: "ES",
	fr: "FR",
	it: "IT",
	multi: "Multi",
	nl: "NL",
};

export const PinnedProjectCard = ({
	project,
	onUnpin,
	isUnpinning,
	onSearchOwner,
}: {
	project: Project;
	// Omitted for guests/externals — the card renders the pin badge
	// as a visual cue but without the unpin affordance.
	onUnpin?: (projectId: string) => void;
	isUnpinning?: boolean;
	onSearchOwner?: (term: string) => void;
}) => {
	const { workspaceId } = useParams();
	const link = `/w/${workspaceId}/projects/${project.id}/home`;
	const conversationCount =
		project.conversations_count ?? project?.conversations?.length ?? 0;
	const audioHours =
		(project as unknown as { audio_hours?: number }).audio_hours ?? 0;
	const languageLabel = project.language
		? (LANGUAGE_LABELS[project.language] ?? project.language.toUpperCase())
		: null;
	const ownerName = (project as any).owner_name as string | undefined;
	const ownerEmail = (project as any).owner_email as string | undefined;

	return (
		<I18nLink
			to={link}
			className="no-underline block h-full"
			style={{ color: "inherit" }}
		>
			<Paper
				component="a"
				p="md"
				className="h-full hover:!border-primary-400 transition-colors"
				withBorder
				{...testId(`pinned-project-card-${project.id}`)}
			>
				<Stack className="h-full" justify="space-between" gap="sm">
					<Stack gap="xs">
						<Group justify="space-between" wrap="nowrap" align="flex-start">
							<Group
								align="center"
								gap="xs"
								wrap="nowrap"
								style={{ minWidth: 0, overflow: "hidden" }}
							>
								<Icons.Calendar style={{ flexShrink: 0 }} />
								<Text
									className="font-semibold"
									size="lg"
									truncate
									{...testId(`pinned-project-card-name-${project.id}`)}
								>
									{project.name}
								</Text>
							</Group>
							<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
								{languageLabel && (
									<Badge size="xs" variant="light" color="gray">
										{languageLabel}
									</Badge>
								)}
								{onUnpin ? (
									<Tooltip label={t`Unpin project`}>
										<ActionIcon
											variant="subtle"
											color="primary"
											size="sm"
											loading={isUnpinning}
											onClick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												onUnpin(project.id);
											}}
										>
											<IconPinFilled size={16} />
										</ActionIcon>
									</Tooltip>
								) : (
									// Read-only pin indicator for viewers without write
									// permission (guest workspaces).
									<IconPinFilled
										size={14}
										color="var(--mantine-color-gray-5)"
									/>
								)}
							</Group>
						</Group>

						<Text size="xs" c="dimmed">
							{audioHours > 0 && (
								<>
									{formatDurationFromHours(audioHours)}
									{" • "}
								</>
							)}
							<Trans>
								{conversationCount} Conversations • Edited{" "}
								{formatRelative(
									new Date(project.updated_at ?? new Date()),
									new Date(),
								)}
							</Trans>
							{(ownerName || ownerEmail) && (
								<>
									{" • "}
									<Tooltip label={ownerEmail} disabled={!ownerEmail}>
										<Text
											size="xs"
											c="dimmed"
											component="span"
											className="cursor-pointer hover:underline"
											onClick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												onSearchOwner?.(ownerEmail ?? ownerName ?? "");
											}}
										>
											{ownerName ?? ownerEmail}
										</Text>
									</Tooltip>
								</>
							)}
						</Text>
					</Stack>

					<Box style={{ display: "flex", justifyContent: "flex-end" }}>
						<AccessBubbles project={project} />
					</Box>
				</Stack>
			</Paper>
		</I18nLink>
	);
};
