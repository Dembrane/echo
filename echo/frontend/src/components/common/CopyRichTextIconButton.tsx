import { ActionIcon, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import useCopyToRichText from "@/hooks/useCopyToRichText";

export const CopyRichTextIconButton = ({ markdown }: { markdown: string }) => {
	const { copy, copied } = useCopyToRichText();

	return (
		<Tooltip
			transitionProps={{ duration: 200 }}
			label={copied ? "Copied" : "Copy"}
			px={5}
		>
			<ActionIcon
				size="md"
				radius="xl"
				color={copied ? "teal" : "gray"}
				variant="subtle"
				onClick={() => copy(markdown)}
			>
				{copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
			</ActionIcon>
		</Tooltip>
	);
};
