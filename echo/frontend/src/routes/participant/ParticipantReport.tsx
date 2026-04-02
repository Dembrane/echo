import { Trans } from "@lingui/react/macro";
import { LoadingOverlay, Stack, Text } from "@mantine/core";
import { useCallback, useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { Logo } from "@/components/common/Logo";
import {
	usePublicLatestProjectReport,
	usePublicProjectReportViews,
} from "@/components/report/hooks";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { createPublicReportMetric } from "@/lib/api";
import { testId } from "@/lib/testUtils";

export const ParticipantReport = () => {
	const [searchParams] = useSearchParams();
	const print = searchParams.get("print") === "true";

	const { language, projectId } = useParams();

	const { data: report, isLoading } = usePublicLatestProjectReport(
		projectId ?? "",
	);
	const { data: views, refetch: refetchViews } = usePublicProjectReportViews(
		projectId ?? "",
	);

	const contributeLink = `${window.location.origin}/${language}/${projectId}/start`;

	const recordView = useCallback(
		(reportId: number) => {
			const key = `rm_${reportId}_updated`;
			try {
				const lastUpdated = localStorage.getItem(key);
				if (lastUpdated) {
					const hoursDiff =
						(Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60);
					if (hoursDiff < 24) return;
				}
				localStorage.setItem(key, new Date().toISOString());
			} catch {
				// Ignore localStorage errors
			}

			createPublicReportMetric(projectId ?? "", {
				project_report_id: reportId,
				type: "view",
			})
				.then(() => {
					setTimeout(() => refetchViews(), 1000);
				})
				.catch(() => {});
		},
		[projectId, refetchViews],
	);

	useEffect(() => {
		if (report) {
			recordView(Number(report.id));

			if (print) {
				setTimeout(() => {
					window.print();
				}, 1000);
			}
		}
	}, [report, print, recordView]);

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
				projectId={projectId ?? ""}
				reportId={Number(report.id)}
				isPublic
				opts={{
					contributeLink: report.show_portal_link ? contributeLink : undefined,
					readingNow: views?.recent ?? 0,
				}}
			/>
		</div>
	);
};
