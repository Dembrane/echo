import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import type { PropsWithChildren } from "react";
import { Icons } from "@/icons";
import { I18nLink } from "../common/i18nLink";

export const ProjectCard = ({
	project,
}: PropsWithChildren<{
	project: Project;
}>) => {
	const link = `/projects/${project.id}/overview`;

	return (
		<Paper p="md" className="h-full" withBorder>
			<Stack className="h-full" justify="space-between">
				<Stack gap="xs">
					<Group justify="space-between" wrap="nowrap">
						<Group align="center">
							<Icons.Calendar />
							<Text className="font-semibold" size="lg">
								{project.name}
							</Text>
						</Group>
						<I18nLink to={link}>
							<ActionIcon component="a" variant="subtle">
								<Icons.Dots />
							</ActionIcon>
						</I18nLink>
					</Group>
					<Text size="sm" c="dimmed">
						<Trans>
							{project.conversations?.length ?? 0} Conversations • Edited{" "}
							{formatRelative(
								new Date(project.updated_at ?? new Date()),
								new Date(),
							)}
						</Trans>
					</Text>
				</Stack>
				<I18nLink to={link} style={{ width: "100%" }}>
					<Button
						rightSection={<IconExternalLink size={20} />}
						fullWidth
						variant="light"
					>
						<Trans>Open</Trans>
					</Button>
				</I18nLink>
			</Stack>
		</Paper>
	);
};
