import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	IconExternalLink,
	IconPinFilled,
} from "@tabler/icons-react";
import { formatRelative } from "date-fns";
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

export const PinnedProjectCard = ({
	project,
	onUnpin,
	isUnpinning,
	onSearchOwner,
}: {
	project: Project;
	onUnpin: (projectId: string) => void;
	isUnpinning?: boolean;
	onSearchOwner?: (term: string) => void;
}) => {
	const link = `/projects/${project.id}/overview`;
	const conversationCount =
		project.conversations_count ?? project?.conversations?.length ?? 0;
	const languageLabel = project.language
		? LANGUAGE_LABELS[project.language] ?? project.language.toUpperCase()
		: null;
	const ownerName = (project as any).owner_name as string | undefined;
	const ownerEmail = (project as any).owner_email as string | undefined;

	return (
		<Paper
			p="md"
			className="h-full hover:!border-primary-400 transition-colors"
			withBorder
			{...testId(`pinned-project-card-${project.id}`)}
		>
			<Stack className="h-full" justify="space-between" gap="sm">
				<Stack gap="xs">
					<Group justify="space-between" wrap="nowrap" align="flex-start">
						<Group align="center" gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
							<Icons.Calendar />
							<Text
								className="font-semibold"
								size="lg"
								lineClamp={1}
								{...testId(`pinned-project-card-name-${project.id}`)}
							>
								{project.name}
							</Text>
							{languageLabel && (
								<Badge size="xs" variant="light" color="gray">
									{languageLabel}
								</Badge>
							)}
						</Group>
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
					</Group>

					<Text size="xs" c="dimmed">
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

				<I18nLink to={link} style={{ width: "100%" }}>
					<Button
						rightSection={<IconExternalLink size={16} />}
						fullWidth
						variant="light"
						size="xs"
						{...testId(`pinned-project-card-open-${project.id}`)}
					>
						<Trans>Open</Trans>
					</Button>
				</I18nLink>
			</Stack>
		</Paper>
	);
};
