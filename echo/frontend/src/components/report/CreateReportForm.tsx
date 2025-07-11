import { Trans } from "@lingui/react/macro";
import { Alert, Button, NativeSelect, Stack } from "@mantine/core";

import { useEffect, useState } from "react";
import { useCreateProjectReportMutation } from "./hooks";
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
  const { iso639_1 } = useLanguage();
  const [language, setLanguage] = useState(iso639_1);

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
    <Stack>
      <CloseableAlert>
        It looks like you don't have a report for this project yet. Please
        create one to get started.
      </CloseableAlert>

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
        Create Report
      </Button>
    </Stack>
  );
};
