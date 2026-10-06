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
		<Paper id={id} withBorder={false} p={{ base: "md", md: "lg" }}>
			<Stack gap="lg">
				<Group justify="space-between" align="flex-start">
					<Stack gap="xs">
						<Title order={2}>{title}</Title>
						{description && (
							<Text size="sm" c="dimmed">
								{description}
							</Text>
						)}
					</Stack>
					{headerRight}
				</Group>

				<Stack gap="md" align={align === "start" ? "flex-start" : "stretch"}>
					{children}
				</Stack>
			</Stack>
		</Paper>
	);
};
