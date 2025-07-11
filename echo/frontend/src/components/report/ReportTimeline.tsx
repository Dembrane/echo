import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
  Brush,
  Area,
  AreaChart,
} from "recharts";
import { Skeleton, Text } from "@mantine/core";
import { useProjectReportTimelineData } from "./hooks";
import { addDays, format, subDays } from "date-fns";
import { t } from "@lingui/core/macro";
import { useState } from "react";

// Pastel color palette
const COLORS = {
  red: "#FF9999", // Pastel red
  orange: "#FFB366", // Pastel orange
  green: "#99CC99", // Pastel green
  blue: "#99CCFF", // Pastel blue
  lavender: "#C8A2C8", // Pastel lavender
  greenFill: "rgba(153, 204, 153, 0.2)", // Transparent green for area fill
  blueFill: "rgba(153, 204, 255, 0.2)", // Transparent blue for area fill
};

const formatDateForAxis = (timestamp: number): string =>
  format(new Date(timestamp), "MMM dd");

const CustomReferenceLabel = ({ value, viewBox }: any) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
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
          fontSize="12px"
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

  if (isLoading || !data) {
    return <Skeleton h={100} />;
  }

  if (error) {
    return (
      <Text className="text-red-500">There was an error loading your data</Text>
    );
  }

  if (!data?.allReports?.length) {
    return <Text>No report data available</Text>;
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
      datetime: day,
      count,
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
      datetime: dayTs,
      conversations: convData?.count ?? 0,
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
      datetime: paddedStartDate,
      conversations: 0,
      views: 0,
    },
    ...timelineData,
    {
      datetime: paddedEndDate,
      conversations: null,
      views: null,
    },
  ];

  const ticks = [
    projectCreatedAt,
    ...data.allReports.map((r) => new Date(r.createdAt!).getTime()),
  ];

  console.log(ticks);

  return (
    <ResponsiveContainer width="100%" minWidth={300} height={200}>
      <AreaChart
        data={paddedData}
        margin={{ top: 40, right: 40, left: 40, bottom: 20 }}
        style={{
          overflow: "visible",
        }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="#E5E7EB"
          vertical={false}
        />

        <XAxis
          dataKey="datetime"
          scale="time"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={formatDateForAxis}
          stroke="#6B7280"
          tickLine={true}
          axisLine={{ stroke: "#E5E7EB" }}
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
                <div className="rounded border border-gray-200 bg-white p-2 shadow">
                  <p className="space-y-[2px] text-sm">
                    {data.conversations != null && (
                      <div>Conversations: {data.conversations}</div>
                    )}
                    {data.views != null && <div>Views: {data.views}</div>}
                  </p>
                  <p className="pt-2 text-sm text-gray-600">
                    {formatDateForAxis(data.datetime)}
                  </p>
                </div>
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
              value: "Project Created",
              type: "plainline",
              color: COLORS.red,
              // @ts-ignore
              payload: {},
            },
            {
              value: "Report Created",
              type: "plainline",
              color: COLORS.orange,
              // @ts-ignore
              payload: {},
            },
            // Only show "Report Updated" if there are multiple reports
            // @ts-ignore
            ...(data.allReports.length > 1
              ? [
                  {
                    value: "Report Updated",
                    type: "plainline",
                    color: COLORS.lavender,
                    // @ts-ignore
                    payload: {},
                  },
                ]
              : []),
            // @ts-ignore
            { value: "Conversations", type: "line", color: COLORS.green },
            // @ts-ignore
            { value: "Views", type: "line", color: COLORS.blue },
          ]}
        />

        {/* Updated Reference Lines */}
        <ReferenceLine
          x={projectCreatedAt}
          stroke={COLORS.red}
          label={<CustomReferenceLabel value={t`Project Created`} />}
        />

        {/* Show first report as "Report Created" */}
        <ReferenceLine
          key={data.allReports[0]?.id}
          x={new Date(data.allReports[0]?.createdAt!).getTime()}
          stroke={COLORS.orange}
          label={
            <CustomReferenceLabel
              value={t`Report Created - ${formatDateForAxis(new Date(data.allReports[0]?.createdAt!).getTime())}`}
            />
          }
        />

        {/* Show all subsequent reports as "Report Updated" */}
        {data.allReports.slice(1).map((r) => (
          <ReferenceLine
            key={r.id}
            x={new Date(r.createdAt!).getTime()}
            stroke={COLORS.lavender}
            label={
              <CustomReferenceLabel
                value={t`Report Updated - ${formatDateForAxis(new Date(r.createdAt!).getTime())}`}
              />
            }
          />
        ))}

        <Area
          name="Conversations"
          type="monotoneY"
          dataKey="conversations"
          stroke={COLORS.green}
          fill={COLORS.greenFill}
          strokeWidth={2}
          dot={{ r: 1, fill: COLORS.green }}
          isAnimationActive={false}
        />

        <Area
          name="Views"
          type="monotoneY"
          dataKey="views"
          stroke={COLORS.blue}
          fill={COLORS.blueFill}
          strokeWidth={2}
          dot={{ r: 1, fill: COLORS.blue }}
          isAnimationActive={false}
        />

        {showBrush && (
          <Brush
            dataKey="datetime"
            height={30}
            stroke="#8884d8"
            tickFormatter={formatDateForAxis}
            startIndex={Math.max(0, paddedData.length - 10)}
            fill="#f5f6f7"
            strokeWidth={1}
            travellerWidth={10}
            className="custom-brush"
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
