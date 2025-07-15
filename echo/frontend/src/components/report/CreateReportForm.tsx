import { Trans } from "@lingui/react/macro";
import {
  Alert,
  Button,
  NativeSelect,
  Stack,
  Text,
  Modal,
} from "@mantine/core";
import { ConversationStatusTable } from "./ConversationStatusTable";

import { useEffect, useState } from "react";
import { useCreateProjectReportMutation, useProjectConversationCounts } from "@/lib/query";
import { useParams } from "react-router-dom";
import { t } from "@lingui/core/macro";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { useLanguage } from "@/hooks/useLanguage";
import { CloseableAlert } from "../common/ClosableAlert";
import { ExponentialProgress } from "../common/ExponentialProgress";

export const CreateReportForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const {
    mutate,
    isPending,
    data: report,
    error,
  } = useCreateProjectReportMutation();
  const { projectId } = useParams();
  const { data: conversationCounts } = useProjectConversationCounts(projectId ?? "");
  const { iso639_1 } = useLanguage();
  const [language, setLanguage] = useState(iso639_1);
  const [modalOpened, setModalOpened] = useState(false);

  useEffect(() => {
    if (report) {
      onSuccess();
    }
  }, [report, onSuccess]);

  if (isPending) {
    return (
      <Stack>
        <Alert title={t`Processing your report...`}>
          <Trans>
            Please wait while we generate your report. You will automatically be
            redirected to the report page.
          </Trans>
        </Alert>
        <ExponentialProgress expectedDuration={60} isLoading={true} />
      </Stack>
    );
  }

  if (error) {
    return (
      <Alert title={t`Error creating report`} color="red">
        <Trans>
          There was an error creating your report. Please try again or contact
          support.
        </Trans>
      </Alert>
    );
  }

  return (
    <Stack maw="500px">


      {/* Inform the user about conversation processing status */}
      {conversationCounts && conversationCounts.total > 0 && (
        <CloseableAlert color="blue" title={t`Conversation processing`} mb={"sm"}>
          <Text>
            <Trans>
              Only the {conversationCounts.finished} finished
              {" "}
              {conversationCounts.finished === 1
                ? "conversation"
                : "conversations"} will be included in the report right now.
              {" "}
            </Trans>
          </Text>
        </CloseableAlert>
      )}

      {/* Detailed Conversation Modal */}
      {conversationCounts && conversationCounts.total > 0 && (
        <>
          <Button
            variant="subtle"
            size="xs"
            mt="xs"
            onClick={() => setModalOpened(true)}
          >
            <Trans>See conversation status details</Trans>
          </Button>
          <Modal
            opened={modalOpened}
            onClose={() => setModalOpened(false)}
            title={<Trans>Conversation Status Details</Trans>}
            size="lg"
            centered
          >
            <ConversationStatusTable projectId={projectId ?? ""} />
          </Modal>
        </>
      )}

      <NativeSelect
        value={language}
        label={t`Please select a language for your report`}
        onChange={(e) => setLanguage(e.target.value)}
        data={languageOptionsByIso639_1}
      />

      <Button
        onClick={() =>
          mutate({
            projectId: projectId ?? "",
            language: language,
          })
        }
        loading={isPending}
        disabled={isPending}
      >
        <Trans>Create Report</Trans>
      </Button>
    </Stack>
  );
};