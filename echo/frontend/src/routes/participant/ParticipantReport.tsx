import { Trans } from "@lingui/react/macro";
import { LoadingOverlay, Stack, Text } from "@mantine/core";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { Logo } from "@/components/common/Logo";
import { useCreateProjectReportMetricOncePerDayMutation } from "@/components/participant/hooks";
import {
	useLatestProjectReport,
	useProjectReportViews,
} from "@/components/report/hooks";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { testId } from "@/lib/testUtils";

export const ParticipantReport = () => {
	const [searchParams] = useSearchParams();
	const print = searchParams.get("print") === "true";

	const { language, projectId } = useParams();

	const { data: report, isLoading } = useLatestProjectReport(projectId ?? "");
	const { data: views } = useProjectReportViews(report?.id ?? -1);

	const contributeLink = `${window.location.origin}/${language}/${projectId}/start`;

	const { mutate } = useCreateProjectReportMetricOncePerDayMutation();

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
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

	if (!report || report.status !== "published") {
		return (
			<Stack
				gap="2rem"
				className="container mx-auto max-w-2xl p-8"
				{...testId("public-report-not-available")}
			>
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
		<div {...testId("public-report-view")}>
			<ReportRenderer
				reportId={Number(report.id)}
				opts={{
					contributeLink: report.show_portal_link ? contributeLink : undefined,
					readingNow: views?.recent ?? 0,
				}}
			/>
		</div>
	);
};
