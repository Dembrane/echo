import { LoadingOverlay, Modal } from "@mantine/core";
import type { VerificationArtifact } from "@/lib/api";
import { Markdown } from "../../common/Markdown";

type ArtefactModalProps = {
	opened: boolean;
	onClose: () => void;
	onExited?: () => void;
	artefact?: (ConversationArtifact | VerificationArtifact) | null;
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
			yOffset="10vh"
			padding="xl"
		>
			<LoadingOverlay visible={isLoading} />
			<Markdown
				className="prose-sm max-w-none"
				content={artefact?.content || ""}
			/>
		</Modal>
	);
};
