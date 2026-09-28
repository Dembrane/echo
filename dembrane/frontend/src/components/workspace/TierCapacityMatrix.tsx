import { Trans } from "@lingui/react/macro";
import { Anchor, Box, Group, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { API_BASE_URL } from "@/config";
import {
	type BillingPeriod,
	fetchTierCapacities,
	formatTierHours as fmtHours,
	formatTierPrice as fmtPrice,
	formatTierPricePeriod as fmtPricePeriod,
	formatTierSeats as fmtSeats,
	isTier,
	TIER_ORDER,
	type Tier,
	type TierCapacity,
	taglineFor,
} from "@/lib/tiers";
import { TierStatusBadge } from "./TierStatusBadge";

interface Props {
	highlightTier?: string;
	fromTier?: string;
	compact?: boolean;
	onTierSelect?: (tier: string) => void;
	billingPeriod?: BillingPeriod;
}

const HIGHLIGHT_BG = "var(--mantine-color-primary-light)";
const HIGHLIGHT_COLOR = "var(--mantine-color-primary-6)";

export const TierCapacityMatrix = ({
	highlightTier,
	fromTier,
	compact = false,
	onTierSelect,
	billingPeriod = "annual",
}: Props) => {
	const { data, isLoading } = useQuery({
		queryFn: () => fetchTierCapacities(API_BASE_URL),
		queryKey: ["v2", "tier-capacities"],
		staleTime: 60 * 60 * 1000,
	});

	if (isLoading || !data || data.length === 0) return null;

	const fromIdx = fromTier ? TIER_ORDER.indexOf(fromTier as Tier) : -1;
	const tiers = data.filter((cap) => {
		if (fromIdx < 0) return true;
		const idx = TIER_ORDER.indexOf(cap.tier as Tier);
		return idx >= 0 && idx > fromIdx;
	});
	if (tiers.length === 0) return null;

	const stickyLabel: React.CSSProperties = {
		background: "var(--app-background)",
		left: 0,
		position: "sticky",
		zIndex: 1,
	};

	const cellStyle = (tier: string): React.CSSProperties => ({
		background: tier === highlightTier ? HIGHLIGHT_BG : undefined,
		cursor: onTierSelect ? "pointer" : undefined,
		minWidth: 120,
		verticalAlign: "top",
	});

	const valStyle = (tier: string): React.CSSProperties => ({
		color: tier === highlightTier ? HIGHLIGHT_COLOR : undefined,
	});

	const labelCellStyle: React.CSSProperties = {
		verticalAlign: "top",
		whiteSpace: "nowrap",
		...stickyLabel,
	};

	const handleClick = (tier: string) => {
		if (onTierSelect) onTierSelect(tier);
	};

	type Row = {
		key: string;
		label: ReactNode;
		render: (cap: TierCapacity) => string;
		renderSub?: (cap: TierCapacity) => string;
	};

	const mainRows: Row[] = [
		{
			key: "price",
			label: <Trans>Price</Trans>,
			render: (cap) => fmtPrice(cap, billingPeriod),
			renderSub: (cap) => fmtPricePeriod(cap, billingPeriod),
		},
	];

	if (!compact) {
		mainRows.push({
			key: "duration",
			label: <Trans>Duration</Trans>,
			render: (c) => c.duration,
		});
	}

	const usageRows: Row[] = [
		{ key: "seats", label: <Trans>Seats</Trans>, render: fmtSeats },
		{ key: "hours", label: <Trans>Hours</Trans>, render: fmtHours },
	];

	function renderRows(rows: Row[]) {
		return rows.map((row) => (
			<Table.Tr key={row.key}>
				<Table.Td style={labelCellStyle}>
					<Text size="sm" c="dimmed">
						{row.label}
					</Text>
				</Table.Td>
				{tiers.map((cap) => (
					<Table.Td
						key={cap.tier}
						style={cellStyle(cap.tier)}
						onClick={() => handleClick(cap.tier)}
					>
						<Text size="sm" style={valStyle(cap.tier)}>
							{row.render(cap)}
						</Text>
						{row.renderSub && (
							<Text
								size="xs"
								c={cap.tier === highlightTier ? HIGHLIGHT_COLOR : "dimmed"}
							>
								{row.renderSub(cap)}
							</Text>
						)}
					</Table.Td>
				))}
			</Table.Tr>
		));
	}

	return (
		<Stack gap={0}>
			<Box
				style={{
					border: "1px solid var(--mantine-color-gray-3)",
					borderRadius: "var(--mantine-radius-default)",
					overflowX: "auto",
				}}
			>
				<Table
					withRowBorders
					verticalSpacing={10}
					horizontalSpacing={16}
					styles={{
						table: { width: "100%" },
					}}
				>
					<Table.Thead>
						<Table.Tr>
							<Table.Th style={labelCellStyle}>
								<Text size="sm" c="dimmed">
									<Trans>Plans</Trans>
								</Text>
							</Table.Th>
							{tiers.map((cap) => {
								const isHighlight = cap.tier === highlightTier;
								const tagline = isTier(cap.tier)
									? taglineFor(cap.tier)
									: cap.tagline;
								return (
									<Table.Th
										key={cap.tier}
										style={{
											background: isHighlight ? HIGHLIGHT_BG : undefined,
											cursor: onTierSelect ? "pointer" : undefined,
											minWidth: 130,
											verticalAlign: "top",
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
												<TierStatusBadge tier={cap.tier} />
											</Group>
											<Text size="xs" c="dimmed" lh={1.3}>
												{tagline}
											</Text>
										</Stack>
									</Table.Th>
								);
							})}
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{renderRows(mainRows)}
						{renderRows(usageRows)}
					</Table.Tbody>
				</Table>
			</Box>
			<Text size="xs" c="dimmed" mt="sm">
				<Trans>
					An additional training is mandatory for teams using dembrane in
					situations classified as high risk under the EU AI Act.
				</Trans>{" "}
				<Anchor
					href="https://www.dembrane.com/platform/pricing#training"
					target="_blank"
					rel="noopener noreferrer"
					inherit
				>
					<Trans>Learn more</Trans>
				</Anchor>
			</Text>
		</Stack>
	);
};
