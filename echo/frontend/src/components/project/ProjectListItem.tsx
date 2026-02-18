import { Trans } from "@lingui/react/macro";
import { Group, Paper, Stack, Text } from "@mantine/core";
import { formatRelative } from "date-fns";
import type { PropsWithChildren } from "react";
import { Icons } from "@/icons";
import { testId } from "@/lib/testUtils";
import { I18nLink } from "../common/i18nLink";

export const ProjectListItem = ({
	project,
}: PropsWithChildren<{
	project: Project;
}>) => {
	const link = `/projects/${project.id}/overview`;

	return (
		<I18nLink to={link}>
			<Paper
				component="a"
				p="sm"
				className="relative hover:!border-primary-400"
				withBorder
				{...testId(`project-list-item-${project.id}`)}
			>
				<Group justify="space-between">
					<Stack gap="0">
						<Group align="center">
							<Icons.Calendar />
							<Text
								className="font-semibold"
								size="lg"
								{...testId(`project-list-item-name-${project.id}`)}
							>
								{project.name}
							</Text>
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
						</Text>
					</Stack>
				</Group>
			</Paper>
		</I18nLink>
	);
};
