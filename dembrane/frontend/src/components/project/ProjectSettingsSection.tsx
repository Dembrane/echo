import { Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

type ProjectSettingsSectionProps = {
	title: ReactNode;
	description?: ReactNode;
	headerRight?: ReactNode;
	children: ReactNode;
	variant?: "default" | "danger";
	align?: "start" | "stretch";
	id?: string;
};

export const ProjectSettingsSection = ({
	title,
	description,
	headerRight,
	children,
	align = "stretch",
	id,
}: ProjectSettingsSectionProps) => {
	return (
		<Paper
			id={id}
			radius="md"
			withBorder={false}
			p={{ base: "1.25rem", md: "1.75rem" }}
		>
			<Stack gap="1.5rem">
				<Group justify="space-between" align="flex-start">
					<Stack gap="0.4rem">
						<Title order={2}>{title}</Title>
						{description && (
							<Text size="sm" c="dimmed">
								{description}
							</Text>
						)}
					</Stack>
					{headerRight}
				</Group>

				<Stack
					gap="1.25rem"
					align={align === "start" ? "flex-start" : "stretch"}
				>
					{children}
				</Stack>
			</Stack>
		</Paper>
	);
};
