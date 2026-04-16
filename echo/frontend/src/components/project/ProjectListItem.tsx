import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Badge, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconPin, IconPinFilled } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import type { PropsWithChildren } from "react";
import { Icons } from "@/icons";
import { testId } from "@/lib/testUtils";
import { I18nLink } from "../common/i18nLink";

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
				<Group justify="space-between">
					<Stack gap="0">
						<Group align="center" gap="xs">
							<Icons.Calendar />
							<Text
								className="font-semibold"
								size="lg"
								{...testId(`project-list-item-name-${project.id}`)}
							>
								{project.name}
							</Text>
							{languageLabel && (
								<Badge size="xs" variant="light" color="gray">
									{languageLabel}
								</Badge>
							)}
						</Group>
						<Text size="sm" c="dimmed">
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
											{ownerName ?? ownerEmail}
										</Text>
									</Tooltip>
								</>
							)}
						</Text>
					</Stack>
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
			</Paper>
		</I18nLink>
	);
};
