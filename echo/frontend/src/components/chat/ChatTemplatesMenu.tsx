import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconDots } from "@tabler/icons-react";
import { TemplatesModal } from "./TemplatesModal";
import { quickAccessTemplates, Templates } from "./templates";

// all this function does is that if someone clicks on a template, it will set the input to the template content
// we need input to check if there is something in the chat box already
export const ChatTemplatesMenu = ({
	onTemplateSelect,
	selectedTemplateKey,
}: {
	onTemplateSelect: ({
		content,
		key,
	}: {
		content: string;
		key: string;
	}) => void;
	selectedTemplateKey?: string | null;
}) => {
	const [opened, { open, close }] = useDisclosure(false);

	// Check if selected template is from modal (not in quick access)
	const isModalTemplateSelected =
		selectedTemplateKey &&
		!quickAccessTemplates.some((t) => t.title === selectedTemplateKey);

	const selectedModalTemplate = isModalTemplateSelected
		? Templates.find((t) => t.title === selectedTemplateKey)
		: null;

	return (
		<>
			<Stack>
				<Group>
					<Text c="gray.7">
						<Trans>Suggested:</Trans>
					</Text>
					{quickAccessTemplates.map((t) => {
						const isSelected = selectedTemplateKey === t.title;
						return (
							// no translations for now
							<Paper
								key={t.title}
								withBorder
								className={`cursor-pointer rounded-full px-2 transition-all ${
									isSelected
										? "border-blue-500 bg-blue-50"
										: "hover:border-gray-300 hover:bg-gray-50"
								}`}
								onClick={() =>
									onTemplateSelect({ content: t.content, key: t.title })
								}
							>
								<Text>{t.title}</Text>
							</Paper>
						);
					})}
					{/* Show selected modal template */}
					{selectedModalTemplate && (
						<Paper
							withBorder
							className="cursor-pointer rounded-full border-blue-500 bg-blue-50 px-2"
							onClick={() =>
								onTemplateSelect({
									content: selectedModalTemplate.content,
									key: selectedModalTemplate.title,
								})
							}
						>
							<Text>{selectedModalTemplate.title}</Text>
						</Paper>
					)}
					<Tooltip label={t`More templates`}>
						<ActionIcon
							variant="default"
							size="lg"
							radius="xl"
							onClick={open}
							className="border-none"
						>
							<IconDots size={22} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Stack>
			<TemplatesModal
				opened={opened}
				onClose={close}
				onTemplateSelect={onTemplateSelect}
				selectedTemplateKey={selectedTemplateKey}
			/>
		</>
	);
};
