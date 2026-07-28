import { Trans } from "@lingui/react/macro";
import { Button, Menu, Text } from "@mantine/core";
import { IconTemplate } from "@tabler/icons-react";
import { useUserTemplates } from "@/components/chat/hooks/useUserTemplates";

/** Quiet insert-only entry point to saved templates: picking one drops its
 * content into the composer. Creating and managing templates stays in the
 * classic chat's templates modal. Renders nothing when there are none. */
export const InsertTemplateMenu = ({
	onInsert,
	workspaceId,
}: {
	onInsert: (content: string) => void;
	workspaceId?: string | null;
}) => {
	const templatesQuery = useUserTemplates(workspaceId);
	const templates = templatesQuery.data ?? [];
	if (templates.length === 0) return null;

	return (
		<Menu position="top-start" withinPortal shadow="md">
			<Menu.Target>
				<Button
					variant="subtle"
					size="xs"
					leftSection={<IconTemplate size={14} />}
				>
					<Trans>Templates</Trans>
				</Button>
			</Menu.Target>
			<Menu.Dropdown className="max-w-md">
				{templates.map((template) => (
					<Menu.Item
						key={template.id}
						onClick={() => onInsert(template.content)}
					>
						<Text size="sm" lineClamp={1}>
							{template.title}
						</Text>
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
};
