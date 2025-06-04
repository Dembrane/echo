import { Trans } from "@lingui/react/macro";
import { IconEdit } from "@tabler/icons-react";
import { Modal, Stack } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";

import { NavigationButton } from "../common/NavigationButton";
import { useCallback } from "react";
import { useLatestProjectReport } from "@/lib/query";
import { useParams, useLocation } from "react-router-dom";
import { t } from "@lingui/core/macro";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { CreateReportForm } from "./CreateReportForm";

export const ReportModalNavigationButton = () => {
  const [opened, { open, close }] = useDisclosure();

  const navigate = useI18nNavigate();

  const { projectId } = useParams();
  const { pathname } = useLocation();

  const { data: projectReport, isFetching: isLoadingProjectReport } =
    useLatestProjectReport(projectId ?? "");

  const handleClick = useCallback(() => {
    if (projectReport) {
      navigate(`/projects/${projectId}/report`);
    } else {
      open();
    }
  }, [projectReport, navigate, open]);

  const handleSuccess = useCallback(() => {
    close();
    navigate(`/projects/${projectId}/report`);
  }, [navigate, projectId, close]);

  return (
    <>
      <Modal opened={opened} onClose={close} title="Create Report" withinPortal>
        <Stack>
          <CreateReportForm onSuccess={handleSuccess} />
        </Stack>
      </Modal>

      <NavigationButton
        loading={isLoadingProjectReport}
        loadingTooltip={t`Connecting to report services...`}
        onClick={handleClick}
        rightIcon={<IconEdit />}
        active={pathname.includes("report")}
      >
        <Trans>Report</Trans>
      </NavigationButton>
    </>
  );
};
