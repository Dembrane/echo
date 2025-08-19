import { Accordion, Stack } from "@mantine/core";
import { ChatAccordion } from "../chat/ChatAccordion";
import { ConversationAccordion } from "../conversation/ConversationAccordion";

export const ProjectAccordion = ({ projectId }: { projectId: string }) => {
  return (
    <Accordion pb="lg"  multiple defaultValue={["conversations"]}>
      <ChatAccordion projectId={projectId} />
      {/* <ResourceAccordion projectId={projectId} /> */}
      <ConversationAccordion projectId={projectId} />
    </Accordion>
  );
};
