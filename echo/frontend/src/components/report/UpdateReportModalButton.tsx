import { Trans } from "@lingui/react/macro";
import {
  Alert,
  Button,
  NativeSelect,
  Stack,
  Modal,
  Tooltip,
} from "@mantine/core";

import { useEffect, useState } from "react";
import { useProjectReport, useCreateProjectReportMutation, useDoesProjectReportNeedUpdate} from "./hooks";
import { useParams } from "react-router";
import { t } from "@lingui/core/macro";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { useLanguage } from "@/hooks/useLanguage";
import { CloseableAlert } from "../common/ClosableAlert";
import { ExponentialProgress } from "../common/ExponentialProgress";
import { useDisclosure } from "@mantine/hooks";

// this is only visible if the report is out of date
export const UpdateReportModalButton = ({
  reportId: currentReportId,
}: {
  reportId: number;
}) => {
  const [opened, { open, close }] = useDisclosure(false);

  const {
    mutateAsync,
    isPending,
    data: report,
    error,
  } = useCreateProjectReportMutation();

  const { data: currentReport } = useProjectReport(currentReportId);

  const { data: doesReportNeedUpdate, isLoading: isCheckingReportNeedUpdate } =
    useDoesProjectReportNeedUpdate(currentReportId ?? -1);

  const { projectId } = useParams();
  const { iso639_1 } = useLanguage();
  const [language, setLanguage] = useState(
    currentReport?.language ?? iso639_1 ?? "en",
  );

  useEffect(() => {
    if (report) {
      close();
    }
  }, [report, close]);

  if (!currentReport || !doesReportNeedUpdate || isCheckingReportNeedUpdate) {
    return null;
  }

  return (
    <>
      <Tooltip label={t`Update the report to include the latest data`}>
        <Button variant="outline" color="gray.9" onClick={open}>
          <Trans>Update</Trans>
        </Button>
      </Tooltip>

      <Modal opened={opened} onClose={close} title={t`Update Report`}>
        {isPending ? (
          <Stack>
            <Alert title={t`Processing your report...`}>
              <Trans>
                Please wait while we update your report. You will automatically
                be redirected to the report page.
              </Trans>
            </Alert>
            <ExponentialProgress expectedDuration={60} isLoading={true} />
          </Stack>
        ) : error ? (
          <Alert title={t`Error updating report`} color="red">
            <Trans>
              There was an error updating your report. Please try again or
              contact support.
            </Trans>
          </Alert>
        ) : (
          <Stack>
            <CloseableAlert>
              <Trans>
                Update your report to include the latest changes in your
                project. The link to share the report would remain the same.
              </Trans>
            </CloseableAlert>

            <NativeSelect
              value={language}
              label={t`Please select a language for your updated report`}
              onChange={(e) => setLanguage(e.target.value)}
              data={languageOptionsByIso639_1}
            />

            <Button
              onClick={async () =>
                await mutateAsync({
                  projectId: projectId ?? "",
                  language: language,
                  otherPayload: {
                    show_portal_link: currentReport.show_portal_link,
                  },
                })
              }
              loading={isPending}
              disabled={isPending}
            >
              <Trans>Update Report</Trans>
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  );
};
