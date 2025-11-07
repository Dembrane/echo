import { Box, LoadingOverlay, Modal, ScrollArea } from "@mantine/core";
import { Markdown } from "../../common/Markdown";

type ArtefactModalProps = {
	opened: boolean;
	onClose: () => void;
	onExited?: () => void;
	artefact?: {
		id: string;
		content: string | null | undefined;
		conversation_id: string | Conversation | null | undefined;
		approved_at: string | null | undefined;
	} | null;
	isLoading?: boolean;
};

export const ArtefactModal = ({
	opened,
	onClose,
	onExited,
	artefact,
	isLoading = false,
}: ArtefactModalProps) => {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			onExitTransitionEnd={onExited}
			size="xl"
			radius="md"
			scrollAreaComponent={ScrollArea.Autosize}
			yOffset="10vh"
			padding="xl"
		>
			<LoadingOverlay visible={isLoading} />
			<Box>
				<Markdown className="prose-sm" content={artefact?.content || ""} />
			</Box>
		</Modal>
	);
};
