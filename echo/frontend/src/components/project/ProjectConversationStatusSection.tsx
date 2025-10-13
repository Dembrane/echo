import { useState } from "react";
import { Trans } from "@lingui/react/macro";
import { Button, Modal } from "@mantine/core";
import { ConversationStatusTable } from "@/components/report/ConversationStatusTable";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

type ProjectConversationStatusSectionProps = {
  projectId: string;
};

export const ProjectConversationStatusSection = ({
  projectId,
}: ProjectConversationStatusSectionProps) => {
  const [modalOpened, setModalOpened] = useState(false);

  return (
    <ProjectSettingsSection
      title={<Trans>Conversation Status</Trans>}
      description={
        <Trans>
          Review processing status for every conversation collected in this project.
        </Trans>
      }
      headerRight={
        <Button variant="subtle" onClick={() => setModalOpened(true)}>
          <Trans>View Details</Trans>
        </Button>
      }
    >
      <Modal
        opened={modalOpened}
        onClose={() => setModalOpened(false)}
        title={<Trans>Conversation Status</Trans>}
        size="lg"
        centered
      >
        <ConversationStatusTable projectId={projectId} />
      </Modal>
    </ProjectSettingsSection>
  );
};


