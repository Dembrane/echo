import { Trans } from "@lingui/react/macro";
import { Box, Group, Paper, Skeleton, Stack, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";
import { cn } from "@/lib/utils";
import { Logo } from "../common/Logo";
import { Markdown } from "../common/Markdown";
import { QRCode } from "../common/QRCode";
import { useProjectReport, usePublicProjectReport } from "./hooks";
import { ReportEditor } from "./ReportEditor";

const ContributeToReportCTA = ({ href }: { href: string }) => {
	return (
		<Paper withBorder p="xl" {...testId("report-contribute-cta")}>
			<Stack className="text-center" align="center" gap="md">
				<Text size="lg">
					<Trans>Share your voice by scanning the QR code</Trans>
				</Text>

				<QRCode
					value={href}
					href={href}
					style={{ height: 200, width: 200 }}
					{...testId("report-contribute-qr")}
				/>
			</Stack>
		</Paper>
	);
};

type ReportLayoutOpts = {
	contributeLink?: string;
	readingNow?: number;
	showBorder?: boolean;
	fullscreen?: boolean;
	className?: string;
};

const ReportLayout = ({
	children,
	contributeLink,
	readingNow,
	showBorder,
	className,
}: {
	children: React.ReactNode;
} & ReportLayoutOpts) => {
	return (
		<Stack
			gap="2rem"
			px={{ base: "1rem", md: "2rem" }}
			py={{ base: "2rem", md: "4rem" }}
			className={cn(
				{
					"border-[var(--app-rule-color)] md:border print:border-none":
						showBorder,
				},
				"mx-auto max-w-2xl transition-all duration-300",
				className,
			)}
		>
			<Group justify="space-between" align="center">
				<Group align="center">
					<Logo />
					<Text>
						<Trans>Report</Trans>
					</Text>
				</Group>
				{readingNow && readingNow > 0 && (
					<Group className="print:hidden">
						<Box
							w={10}
							h={10}
							bg="red.7"
							className="animate-pulse rounded-full"
						/>
						<Trans>{readingNow} reading now</Trans>
					</Group>
				)}
			</Group>

			{children}

			{!!contributeLink && <ContributeToReportCTA href={contributeLink} />}
		</Stack>
	);
};

export const ReportRenderer = ({
	projectId,
	reportId,
	opts,
	isEditing,
	isPublic,
}: {
	projectId: string;
	reportId: number;
	opts?: ReportLayoutOpts;
	isEditing?: boolean;
	isPublic?: boolean;
}) => {
	const authQuery = useProjectReport(projectId, isPublic ? -1 : reportId);
	const publicQuery = usePublicProjectReport(
		projectId,
		isPublic ? reportId : -1,
	);
	const { data, isLoading } = isPublic ? publicQuery : authQuery;

	if (isLoading) {
		return (
			<div {...testId("report-renderer-loading")}>
				<ReportLayout {...opts}>
					<Skeleton height="100px" />
					<Skeleton height="200px" />
				</ReportLayout>
			</div>
		);
	}

	if (!data) {
		return (
			<div {...testId("report-renderer-not-found")}>
				<ReportLayout {...opts}>
					<Text>
						<Trans>No report found</Trans>
					</Text>
				</ReportLayout>
			</div>
		);
	}

	return (
		<div className="py-8" {...testId("report-renderer-container")}>
			<ReportLayout
				{...opts}
				showBorder={true}
				className={isEditing ? "max-w-3xl" : ""}
			>
				{isEditing ? (
					<ReportEditor report={data as ProjectReport} />
				) : (
					<Markdown content={data?.content ?? ""} />
				)}
			</ReportLayout>
		</div>
	);
};
