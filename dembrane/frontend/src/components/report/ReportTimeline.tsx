import { t } from "@lingui/core/macro";
import { Paper, Skeleton, Stack, Text } from "@mantine/core";
import { addDays, format, subDays } from "date-fns";
import { useState } from "react";
import {
	Area,
	AreaChart,
	Brush,
	CartesianGrid,
	Legend,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { roles } from "@/colors";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useProjectReportTimelineData } from "./hooks";

// Chart colours from the colour roles (src/colors.ts)
const COLORS = {
	axis: roles.muted,
	conversations: roles.success,
	grid: roles.quiet,
	projectCreated: roles.text,
	reportCreated: roles.warning,
	reportUpdated: roles.muted,
	views: roles.action,
};

const AREA_FILL_OPACITY = 0.15;

const formatDateForAxis = (timestamp: number): string =>
	format(new Date(timestamp), "MMM dd");

const CustomReferenceLabel = ({ value, viewBox }: any) => {
	const [isHovered, setIsHovered] = useState(false);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: needs to be fixed
		<g
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{/* Invisible wider line for better hover detection */}
			<line
				x1={viewBox.x}
				y1={viewBox.y}
				x2={viewBox.x}
				y2={viewBox.height}
				stroke="transparent"
				strokeWidth={20}
				className="cursor-pointer"
			/>
			{/* Visible thin line */}
			<line
				x1={viewBox.x}
				y1={viewBox.y}
				x2={viewBox.x}
				y2={viewBox.height}
				stroke={viewBox.stroke}
				strokeWidth={2}
				className="cursor-pointer"
			/>
			{isHovered && (
				<text
					x={viewBox.x}
					y={viewBox.y}
					dy={-10}
					fill={viewBox.stroke}
					fontSize="14px"
					textAnchor="middle"
				>
					{value}
				</text>
			)}
		</g>
	);
};

export function ReportTimeline({
	reportId,
	showBrush,
}: {
	reportId: string;
	showBrush?: boolean;
}) {
	const { data, isLoading, error } = useProjectReportTimelineData(reportId);

	if (error) {
		return (
			<ErrorNotice
				error={error}
				title={t`There was an error loading your data`}
			/>
		);
	}

	if (isLoading || !data) {
		return <Skeleton h={100} />;
	}

	if (!data?.allReports?.length) {
		return (
			<Text size="sm" c="dimmed">
				{t`No report data available`}
			</Text>
		);
	}

	// Convert all dates to timestamps
	const projectCreatedAt = new Date(data.projectCreatedAt ?? "").getTime();

	/**
	 * Helper function to group items by day and count them.
	 * dateKey is the property name for the item's date field (e.g., 'created_at', 'date_created')
	 */
	function groupByDay(items: any[], dateKey: string) {
		const dayMap = new Map<number, number>();
		items.forEach((item) => {
			const rawDate = item[dateKey];
			if (!rawDate) return;
			const dt = new Date(rawDate);
			// "Floor" to the start of the day
			const dayTs = new Date(
				dt.getFullYear(),
				dt.getMonth(),
				dt.getDate(),
			).getTime();
			dayMap.set(dayTs, (dayMap.get(dayTs) ?? 0) + 1);
		});
		// Convert map to an array of { datetime, count }
		return Array.from(dayMap.entries()).map(([day, count]) => ({
			count,
			datetime: day,
		}));
	}

	// Group conversation data by day
	const conversationDailyData = groupByDay(data.conversations, "created_at");
	// Group metrics ("views") data by day
	const metricsDailyData = groupByDay(
		data.projectReportMetrics,
		"date_created",
	);

	// Collect all unique day timestamps
	const allDays = [
		...new Set([
			...conversationDailyData.map((d) => d.datetime),
			...metricsDailyData.map((d) => d.datetime),
		]),
	].sort((a, b) => a - b);

	// Build the timeline data with daily aggregates
	const timelineData = allDays.map((dayTs) => {
		const convData = conversationDailyData.find((c) => c.datetime === dayTs);
		const metricData = metricsDailyData.find((m) => m.datetime === dayTs);
		return {
			conversations: convData?.count ?? 0,
			datetime: dayTs,
			views: metricData?.count ?? 0,
		};
	});

	// last date in data for reference lines
	const lastDate = Math.max(
		timelineData[timelineData.length - 1]?.datetime ?? 0,
		new Date(
			data.allReports[data.allReports.length - 1]?.createdAt ?? 0,
		).getTime(),
	);

	// Add some padding dates
	const paddedStartDate = subDays(new Date(projectCreatedAt), 1).getTime();
	const paddedEndDate = addDays(new Date(lastDate), 1).getTime();

	// Insert the padded start point:
	const paddedData = [
		{
			conversations: 0,
			datetime: paddedStartDate,
			views: 0,
		},
		...timelineData,
		{
			conversations: null,
			datetime: paddedEndDate,
			views: null,
		},
	];

	const ticks = [
		projectCreatedAt,
		...data.allReports.map((r) => new Date(r.createdAt!).getTime()),
	];

	return (
		<ResponsiveContainer width="100%" minWidth={300} height={200}>
			<AreaChart
				data={paddedData}
				margin={{ bottom: 20, left: 40, right: 40, top: 40 }}
				style={{
					overflow: "visible",
				}}
			>
				<CartesianGrid
					strokeDasharray="3 3"
					stroke={COLORS.grid}
					vertical={false}
				/>

				<XAxis
					dataKey="datetime"
					scale="time"
					type="number"
					domain={["dataMin", "dataMax"]}
					tickFormatter={formatDateForAxis}
					stroke={COLORS.axis}
					tickLine={true}
					axisLine={{ stroke: COLORS.grid }}
					ticks={ticks}
				/>

				<YAxis
					hide={true}
					domain={[
						0,
						Math.max(
							...paddedData.map((d) =>
								Math.max(d.conversations ?? 0, d.views ?? 0),
							),
						) + 10,
					]}
				/>

				<Tooltip
					content={({ active, payload }) => {
						if (active && payload && payload.length) {
							const data = payload[0].payload;
							return (
								<Paper withBorder p="sm">
									<Stack gap="xs">
										{data.conversations != null && (
											<Text size="sm">
												{t`Conversations: ${data.conversations}`}
											</Text>
										)}
										{data.views != null && (
											<Text size="sm">{t`Views: ${data.views}`}</Text>
										)}
										<Text size="sm" c="dimmed" pt="xs">
											{formatDateForAxis(data.datetime)}
										</Text>
									</Stack>
								</Paper>
							);
						}
						return null;
					}}
				/>

				<Legend
					align="right"
					verticalAlign="middle"
					layout="vertical"
					wrapperStyle={{
						paddingLeft: "2rem",
					}}
					payload={[
						{
							color: COLORS.projectCreated,
							// @ts-expect-error
							payload: {},
							type: "plainline",
							value: t`Project created`,
						},
						{
							color: COLORS.reportCreated,
							// @ts-expect-error
							payload: {},
							type: "plainline",
							value: t`Report created`,
						},
						// Only show "Report Updated" if there are multiple reports
						// @ts-expect-error
						...(data.allReports.length > 1
							? [
									{
										color: COLORS.reportUpdated,
										payload: {},
										type: "plainline",
										value: t`Report updated`,
									},
								]
							: []),
						{
							color: COLORS.conversations,
							// @ts-expect-error
							type: "line",
							value: t`Conversations`,
						},
						// @ts-expect-error
						{ color: COLORS.views, type: "line", value: t`Views` },
					]}
				/>

				{/* Updated Reference Lines */}
				<ReferenceLine
					x={projectCreatedAt}
					stroke={COLORS.projectCreated}
					label={<CustomReferenceLabel value={t`Project created`} />}
				/>

				{/* Show first report as "Report Created" */}
				<ReferenceLine
					key={data.allReports[0]?.id}
					x={new Date(data.allReports[0]?.createdAt!).getTime()}
					stroke={COLORS.reportCreated}
					label={
						<CustomReferenceLabel
							value={t`Report created · ${formatDateForAxis(new Date(data.allReports[0]?.createdAt!).getTime())}`}
						/>
					}
				/>

				{/* Show all subsequent reports as "Report Updated" */}
				{data.allReports.slice(1).map((r) => (
					<ReferenceLine
						key={r.id}
						x={new Date(r.createdAt!).getTime()}
						stroke={COLORS.reportUpdated}
						label={
							<CustomReferenceLabel
								value={t`Report updated · ${formatDateForAxis(new Date(r.createdAt!).getTime())}`}
							/>
						}
					/>
				))}

				<Area
					name="Conversations"
					type="monotoneY"
					dataKey="conversations"
					stroke={COLORS.conversations}
					fill={COLORS.conversations}
					fillOpacity={AREA_FILL_OPACITY}
					strokeWidth={2}
					dot={{ fill: COLORS.conversations, r: 1 }}
					isAnimationActive={false}
				/>

				<Area
					name="Views"
					type="monotoneY"
					dataKey="views"
					stroke={COLORS.views}
					fill={COLORS.views}
					fillOpacity={AREA_FILL_OPACITY}
					strokeWidth={2}
					dot={{ fill: COLORS.views, r: 1 }}
					isAnimationActive={false}
				/>

				{showBrush && (
					<Brush
						dataKey="datetime"
						height={30}
						stroke={COLORS.views}
						tickFormatter={formatDateForAxis}
						startIndex={Math.max(0, paddedData.length - 10)}
						fill={roles.bg}
						strokeWidth={1}
						travellerWidth={10}
						className="custom-brush"
					/>
				)}
			</AreaChart>
		</ResponsiveContainer>
	);
}
