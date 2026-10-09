import { t } from "@lingui/core/macro";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import useCopyToRichText from "@/hooks/useCopyToRichText";

export const CopyRichTextIconButton = ({
	markdown,
	size,
	iconSize = 20,
}: {
	markdown: string;
	size?: "xs" | "sm" | "md" | "lg";
	iconSize?: number;
}) => {
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
			label={isLoading ? t`Copying…` : copied ? t`Copied` : t`Copy`}
		>
			<ActionIcon
				aria-label={t`Copy`}
				size={size}
				color={copied ? "teal" : "gray"}
				variant="subtle"
				onClick={handleCopy}
				disabled={isLoading}
			>
				{isLoading ? (
					<Loader size={iconSize} />
				) : copied ? (
					<CheckIcon size={iconSize} />
				) : (
					<CopyIcon size={iconSize} />
				)}
			</ActionIcon>
		</Tooltip>
	);
};
