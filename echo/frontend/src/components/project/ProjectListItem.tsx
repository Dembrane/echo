import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Avatar, Badge, Box, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconLock, IconPin, IconPinFilled } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import type { PropsWithChildren } from "react";
import { Icons } from "@/icons";
import { avatarUrl } from "@/lib/avatar";
import { testId } from "@/lib/testUtils";
import { formatDurationFromHours } from "@/lib/time";
import { I18nLink } from "../common/i18nLink";

/**
 * Access bubbles rendered on the project list card.
 *
 * Design call (2026-04-21):
 *   - Up to 3 real avatars + a rounded `+N` overflow bubble in Royal Blue.
 *   - Single group tooltip: "Shared with Alice, Bob, Carol and 12 others".
 *   - Lives in a fixed-width slot so bubbles align down the column.
 *   - Private project with count=0 still shows a single creator placeholder
 *     so the grid doesn't get holes.
 */
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
	// Empty preview for a project we got in the list — rare but render a
	// placeholder bubble so the column alignment doesn't break.
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
	en: "EN",
	nl: "NL",
	de: "DE",
	fr: "FR",
	es: "ES",
	it: "IT",
	multi: "Multi",
};

export const ProjectListItem = ({
	project,
	onTogglePin,
	isPinned,
	canPin,
	onSearchOwner,
}: PropsWithChildren<{
	project: Project;
	onTogglePin?: (projectId: string) => void;
	isPinned?: boolean;
	canPin?: boolean;
	onSearchOwner?: (term: string) => void;
}>) => {
	const link = `/projects/${project.id}/overview`;
	const languageLabel = project.language
		? LANGUAGE_LABELS[project.language] ?? project.language.toUpperCase()
		: null;
	const ownerName = (project as any).owner_name as string | undefined;
	const ownerEmail = (project as any).owner_email as string | undefined;

	return (
		<I18nLink to={link}>
			<Paper
				component="a"
				p="sm"
				className="group relative hover:!border-primary-400"
				withBorder
				{...testId(`project-list-item-${project.id}`)}
			>
				<Group justify="space-between" wrap="nowrap">
					<Stack gap="0" style={{ flex: 1, minWidth: 0 }}>
						<Group align="center" gap="xs" wrap="nowrap">
							<Icons.Calendar />
							<Text
								className="font-semibold"
								size="lg"
								{...testId(`project-list-item-name-${project.id}`)}
							>
								{project.name}
							</Text>
							{/* Muted lock marks private projects on the list. */}
							{(project as unknown as { visibility?: string })
								.visibility === "private" && (
								<Tooltip label={t`Private project`} withArrow>
									<IconLock
										size={14}
										style={{ color: "var(--mantine-color-gray-6)" }}
										aria-label={t`Private project`}
									/>
								</Tooltip>
							)}
							{languageLabel && (
								<Badge size="xs" variant="light" color="gray">
									{languageLabel}
								</Badge>
							)}
						</Group>
						<Text size="sm" c="dimmed">
							{((project as unknown as { audio_hours?: number }).audio_hours ?? 0) > 0 && (
								<>
									{formatDurationFromHours(
										(project as unknown as { audio_hours?: number }).audio_hours ?? 0,
									)}
									{" • "}
								</>
							)}
							<Trans>
								{project.conversations_count ??
									project?.conversations?.length ??
									0}{" "}
								Conversations • Edited{" "}
								{formatRelative(
									new Date(project.updated_at ?? new Date()),
									new Date(),
								)}
							</Trans>
							{(ownerName || ownerEmail) && (
								<>
									{" • "}
									{/* Show name by default; email only on hover via tooltip.
									    Matches the "don't display emails by default in lists"
									    rule from CLAUDE.md + brand style guide. Falls back to
									    email when the owner has no display_name (rare). */}
									<Tooltip label={ownerEmail} disabled={!ownerEmail}>
										<Text
											size="sm"
											c="dimmed"
											component="span"
											className="cursor-pointer hover:underline"
											onClick={(e: React.MouseEvent) => {
												e.preventDefault();
												e.stopPropagation();
												onSearchOwner?.(ownerEmail ?? ownerName ?? "");
											}}
										>
											{ownerName || t`Unknown`}
										</Text>
									</Tooltip>
								</>
							)}
						</Text>
					</Stack>

					{/* Access bubbles — dedicated slot directly left of the pin.
					    Fixed min-width keeps them aligned down the column so rows
					    scan cleanly. See design-subagent decision 2026-04-21. */}
					<Group gap="md" wrap="nowrap" align="center">
						<Box style={{ minWidth: 96, display: "flex", justifyContent: "flex-end" }}>
							<AccessBubbles project={project} />
						</Box>
						{onTogglePin && (
							<Tooltip
								label={
									isPinned
										? t`Unpin project`
										: canPin
											? t`Pin project`
											: t`Unpin a project first (max 3)`
								}
							>
								<ActionIcon
									variant="subtle"
									color={isPinned ? "primary" : "gray"}
									className={isPinned ? "" : "opacity-0 group-hover:opacity-100 transition-opacity"}
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										if (isPinned || canPin) {
											onTogglePin(project.id);
										}
									}}
								>
									{isPinned ? <IconPinFilled size={18} /> : <IconPin size={18} />}
								</ActionIcon>
							</Tooltip>
						)}
					</Group>
				</Group>
			</Paper>
		</I18nLink>
	);
};
