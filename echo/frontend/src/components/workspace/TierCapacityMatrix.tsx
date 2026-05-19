import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import {
	TIER_ORDER,
	type TierCapacity,
	fetchTierCapacities,
} from "@/lib/tiers";

function fmtPrice(cap: TierCapacity): string {
	if (cap.price_eur_monthly != null) {
		return `€${cap.price_eur_monthly.toLocaleString("en-IE")}`;
	}
	return cap.price_note || t`Custom`;
}

function fmtPricePeriod(cap: TierCapacity): string {
	if (cap.price_eur_monthly != null) return t`/mo`;
	if (cap.price_note?.includes("one-time")) return t`one-time`;
	return "";
}

function fmtSeats(cap: TierCapacity): string {
	if (cap.included_seats == null) return "∞";
	return String(cap.included_seats);
}

function fmtHours(cap: TierCapacity): string {
	if (cap.included_hours == null) return "∞";
	return String(cap.included_hours);
}

function fmtSeatOverage(cap: TierCapacity): string {
	if (cap.seat_overage_eur == null) return "—";
	return t`+€${cap.seat_overage_eur}/seat`;
}

function fmtHourOverage(cap: TierCapacity): string {
	if (cap.hard_block_on_hours) return "€0";
	if (cap.hour_overage_eur == null) return "—";
	return t`€${cap.hour_overage_eur}/h`;
}

interface Props {
	highlightTier?: string;
	fromTier?: string;
	compact?: boolean;
	onTierSelect?: (tier: string) => void;
}

const HIGHLIGHT_BG = "var(--mantine-color-primary-light)";
const HIGHLIGHT_COLOR = "var(--mantine-color-primary-6)";

export const TierCapacityMatrix = ({
	highlightTier,
	fromTier,
	compact = false,
	onTierSelect,
}: Props) => {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "tier-capacities"],
		queryFn: () => fetchTierCapacities(API_BASE_URL),
		staleTime: 60 * 60 * 1000,
	});

	if (isLoading || !data || data.length === 0) return null;

	const fromIdx = fromTier ? TIER_ORDER.indexOf(fromTier as typeof TIER_ORDER[number]) : -1;
	const tiers = data.filter((cap) => {
		if (fromIdx < 0) return true;
		const idx = TIER_ORDER.indexOf(cap.tier as typeof TIER_ORDER[number]);
		return idx >= 0 && idx > fromIdx;
	});
	if (tiers.length === 0) return null;

	const stickyLabel: React.CSSProperties = {
		position: "sticky",
		left: 0,
		background: "var(--app-background)",
		zIndex: 1,
	};

	const cellStyle = (tier: string): React.CSSProperties => ({
		padding: "10px 16px",
		borderBottom: "1px solid var(--mantine-color-gray-1)",
		background: tier === highlightTier ? HIGHLIGHT_BG : undefined,
		cursor: onTierSelect ? "pointer" : undefined,
		verticalAlign: "top",
		minWidth: 120,
	});

	const valStyle = (tier: string): React.CSSProperties => ({
		color: tier === highlightTier ? HIGHLIGHT_COLOR : undefined,
	});

	const labelCellStyle: React.CSSProperties = {
		padding: "10px 16px",
		borderBottom: "1px solid var(--mantine-color-gray-1)",
		verticalAlign: "top",
		whiteSpace: "nowrap",
		...stickyLabel,
	};

	const handleClick = (tier: string) => {
		if (onTierSelect) onTierSelect(tier);
	};

	type Row = {
		label: string;
		render: (cap: TierCapacity) => string;
		renderSub?: (cap: TierCapacity) => string;
	};

	const mainRows: Row[] = [
		{
			label: "Price",
			render: fmtPrice,
			renderSub: fmtPricePeriod,
		},
	];

	if (!compact) {
		mainRows.push({
			label: "Duration",
			render: (c) => c.duration,
		});
	}

	const usageRows: Row[] = [
		{ label: "Seats (included)", render: fmtSeats },
		{ label: "Hours (included)", render: fmtHours },
	];

	const overageRows: Row[] = [
		{ label: "Additional seat", render: fmtSeatOverage },
		{ label: "Additional hour", render: fmtHourOverage },
	];

	const trainingRows: Row[] = [
		{ label: "Training", render: (c) => c.training_included },
	];

	function renderRows(rows: Row[]) {
		return rows.map((row) => (
			<tr key={row.label}>
				<td style={labelCellStyle}>
					<Text size="sm" c="dimmed">
						<Trans id={row.label}>{row.label}</Trans>
					</Text>
				</td>
				{tiers.map((cap) => (
					<td
						key={cap.tier}
						style={cellStyle(cap.tier)}
						onClick={() => handleClick(cap.tier)}
					>
						<Text size="sm" style={valStyle(cap.tier)}>
							{row.render(cap)}
						</Text>
						{row.renderSub && (
							<Text size="xs" c={cap.tier === highlightTier ? HIGHLIGHT_COLOR : "dimmed"}>
								{row.renderSub(cap)}
							</Text>
						)}
					</td>
				))}
			</tr>
		));
	}

	return (
		<Stack gap={0}>
			<Box
				style={{
					overflowX: "auto",
					border: "1px solid var(--mantine-color-gray-3)",
					borderRadius: "var(--mantine-radius-default)",
				}}
			>
				<table
					style={{
						width: "100%",
						borderCollapse: "collapse",
					}}
				>
					<thead>
						<tr>
							<th
								style={{
									padding: "12px 16px",
									textAlign: "left",
									verticalAlign: "top",
									borderBottom: "1px solid var(--mantine-color-gray-3)",
									whiteSpace: "nowrap",
									...stickyLabel,
								}}
							>
								<Text size="sm" c="dimmed">
									<Trans>Plans</Trans>
								</Text>
							</th>
							{tiers.map((cap) => {
								const isHighlight = cap.tier === highlightTier;
								return (
									<th
										key={cap.tier}
										style={{
											padding: "12px 16px",
											textAlign: "left",
											verticalAlign: "top",
											borderBottom: "1px solid var(--mantine-color-gray-3)",
											background: isHighlight ? HIGHLIGHT_BG : undefined,
											cursor: onTierSelect ? "pointer" : undefined,
											minWidth: 130,
										}}
										onClick={() => handleClick(cap.tier)}
									>
										<Stack gap={4}>
											<Group gap={8} wrap="nowrap">
												<Text
													size="sm"
													c={isHighlight ? HIGHLIGHT_COLOR : undefined}
													style={{ textTransform: "capitalize" }}
												>
													{cap.tier}
												</Text>
												{cap.tier === "innovator" && (
													<Badge
														variant="light"
														size="xs"
													>
														<Trans>Popular</Trans>
													</Badge>
												)}
											</Group>
											<Text size="xs" c="dimmed" lh={1.3}>
												{cap.tagline}
											</Text>
										</Stack>
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{renderRows(mainRows)}
						{!compact && (
							<>
								{renderRows(usageRows)}
								{renderRows(overageRows)}
								{renderRows(trainingRows)}
							</>
						)}
						{compact && (
							<>
								{renderRows(usageRows)}
								{renderRows(overageRows)}
							</>
						)}
					</tbody>
				</table>
			</Box>
		</Stack>
	);
};
