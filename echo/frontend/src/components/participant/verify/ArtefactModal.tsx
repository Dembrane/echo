import { LoadingOverlay, Modal } from "@mantine/core";
import type { VerificationArtifact } from "@/lib/api";
import { testId } from "@/lib/testUtils";
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
			{...testId("portal-verified-artefact-modal")}
		>
			<LoadingOverlay visible={isLoading} />
			<div {...testId("portal-verified-artefact-modal-content")}>
				<Markdown
					className="prose-sm max-w-none"
					content={artefact?.content || ""}
				/>
			</div>
		</Modal>
	);
};
