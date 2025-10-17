import { Accordion } from "@mantine/core";
import type { RefObject } from "react";
import { ChatAccordion } from "../chat/ChatAccordion";
import { ConversationAccordion } from "../conversation/ConversationAccordion";

export const ProjectAccordion = ({
	projectId,
	qrCodeRef,
}: {
	projectId: string;
	qrCodeRef?: RefObject<HTMLDivElement | null>;
}) => {
	return (
		<Accordion pb="lg" multiple defaultValue={["conversations"]}>
			<ChatAccordion projectId={projectId} />
			{/* <ResourceAccordion projectId={projectId} /> */}
			<ConversationAccordion projectId={projectId} qrCodeRef={qrCodeRef} />
		</Accordion>
	);
};
