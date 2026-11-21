import { Group, Paper, Stack, Text, Title } from "@mantine/core";
import { createContext, type ReactNode, useContext } from "react";

/**
 * Whether sections stand alone on their page (their title is the page's, order 2) or sit
 * as cards under a page title (order 4), as on Brief and Advanced (ECHO-1060).
 */
export const SettingsSectionLevel = createContext<"page" | "card">("page");

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
	const level = useContext(SettingsSectionLevel);
	return (
		<Paper id={id} withBorder={false} p={{ base: "md", md: "lg" }}>
			<Stack gap="lg">
				<Group justify="space-between" align="flex-start">
					<Stack gap="xs">
						<Title order={level === "card" ? 4 : 2}>{title}</Title>
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
