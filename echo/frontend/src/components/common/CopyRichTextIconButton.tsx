import { t } from "@lingui/core/macro";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import useCopyToRichText from "@/hooks/useCopyToRichText";

export const CopyRichTextIconButton = ({ markdown }: { markdown: string }) => {
	const { copy, copied } = useCopyToRichText();
	const [isLoading, setIsLoading] = useState(false);

	const handleCopy = async () => {
		if (isLoading) return;

		setIsLoading(true);
		try {
			await copy(markdown);
		} catch (error) {
			console.error("Failed to copy chat:", error);
			toast.error(t`Failed to copy chat. Please try again.`);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Tooltip
			transitionProps={{ duration: 200 }}
			label={isLoading ? t`Copying...` : copied ? t`Copied` : t`Copy`}
			px={5}
		>
			<ActionIcon
				size="md"
				radius="xl"
				color={copied ? "teal" : "gray"}
				variant="subtle"
				onClick={handleCopy}
				disabled={isLoading}
			>
				{isLoading ? (
					<Loader size={18} />
				) : copied ? (
					<IconCheck size={18} />
				) : (
					<IconCopy size={18} />
				)}
			</ActionIcon>
		</Tooltip>
	);
};
