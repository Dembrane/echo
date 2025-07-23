import { useParams, useSearchParams } from "react-router-dom";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { useCreateProjectReportMetricOncePerDayMutation } from "@/components/participant/hooks";
import { useProjectReportViews, useLatestProjectReport } from "@/components/report/hooks";
import { LoadingOverlay, Text, Title, Stack } from "@mantine/core";
import { Trans } from "@lingui/react/macro";
import { Logo } from "@/components/common/Logo";
import { useEffect } from "react";

export const ParticipantReport = () => {
  const [searchParams] = useSearchParams();
  const print = searchParams.get("print") === "true";

  const { language, projectId } = useParams();

  const { data: report, isLoading } = useLatestProjectReport(projectId ?? "");
  const { data: views } = useProjectReportViews(report?.id ?? -1);

  const contributeLink = `${window.location.origin}/${language}/${projectId}/start`;

  const { mutate } = useCreateProjectReportMetricOncePerDayMutation();

  useEffect(() => {
    if (report) {
      mutate({
        payload: {
          project_report_id: Number(report.id),
          type: "view",
        },
      });

      if (print) {
        setTimeout(() => {
          window.print();
        }, 1000);
      }
    }
  }, [report, print]);

  if (isLoading) {
    return <LoadingOverlay visible />;
  }

  if (!report || report.status != "published") {
    return (
      <Stack gap="2rem" className="container mx-auto max-w-2xl p-8">
        <a href="https://dembrane.com">
          <Logo />
        </a>

        <Text>
          <Trans>This report is not yet available. </Trans>
        </Text>

        <Text>
          <Trans>
            Please check back later or contact the project owner for more
            information.
          </Trans>
        </Text>
      </Stack>
    );
  }

  return (
    <ReportRenderer
      reportId={Number(report.id)}
      opts={{
        contributeLink: report.show_portal_link ? contributeLink : undefined,
        readingNow: views?.recent ?? 0,
      }}
    />
  );
};
