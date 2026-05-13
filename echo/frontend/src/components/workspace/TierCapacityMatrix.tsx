import { Trans } from "@lingui/react/macro";
import { Box, Paper, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

interface TierCapacity {
	tier: string;
	tagline: string;
	price_eur_monthly: number | null;
	price_note: string;
	duration: string;
	included_seats: number | null;
	seat_overage_eur: number | null;
	included_hours: number | null;
	hour_overage_eur: number | null;
	hard_block_on_hours: boolean;
	guest_cap: number | null;
	training_included: string;
}

async function fetchTierCapacities(): Promise<TierCapacity[]> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/tier-capacities`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

function fmtEur(value: number | null): string {
	if (value == null) return "—";
	return `€${value}`;
}

function fmtPrice(cap: TierCapacity): string {
	if (cap.price_eur_monthly == null) {
		return cap.price_note; // e.g. "€349 one-time"
	}
	return `€${cap.price_eur_monthly}/mo`;
}

function fmtSeats(cap: TierCapacity): string {
	if (cap.included_seats == null) return "∞";
	return String(cap.included_seats);
}

function fmtSeatOverage(cap: TierCapacity): string {
	if (cap.seat_overage_eur == null) return "—";
	return `+${fmtEur(cap.seat_overage_eur)}/seat`;
}

function fmtHours(cap: TierCapacity): string {
	if (cap.included_hours == null) return "∞";
	return String(cap.included_hours);
}

function fmtHourOverage(cap: TierCapacity): string {
	if (cap.hard_block_on_hours) return "hard block";
	if (cap.hour_overage_eur == null) return "—";
	return `${fmtEur(cap.hour_overage_eur)}/h`;
}

function fmtGuests(cap: TierCapacity): string {
	if (cap.guest_cap == null) return "∞";
	return String(cap.guest_cap);
}

interface Props {
	/** Optional: highlight one tier column (e.g. the workspace's current
	 * tier). */
	highlightTier?: string;
	/** Optional: cap the rendered tiers to those at or above this one.
	 * Useful in the upgrade modal where tiers below the current aren't
	 * relevant. */
	fromTier?: string;
	/** Compact mode drops the long rows (overage, training) to fit narrow
	 * modals. Default false. */
	compact?: boolean;
}

const TIER_ORDER = [
	"pilot",
	"pioneer",
	"innovator",
	"changemaker",
	"guardian",
];

/**
 * Matrix v1.1 §1 — tier × capacity table rendered in-product.
 *
 * Contract: "the tier capacity matrix must be visible inside the product
 * at minimum on the workspace billing tab and in the upgrade-request
 * modal. Customers should never have to leave the app to understand what
 * each tier gets them."
 *
 * Two render surfaces today: UpgradeModal (compact=true, fromTier set to
 * the caller's current) and — when the settings tab split lands — the
 * billing tab (compact=false, full history).
 */
export const TierCapacityMatrix = ({
	highlightTier,
	fromTier,
	compact = false,
}: Props) => {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "tier-capacities"],
		queryFn: fetchTierCapacities,
		// Static per deploy — cache aggressively.
		staleTime: 60 * 60 * 1000,
	});

	if (isLoading || !data || data.length === 0) return null;

	const fromIdx = fromTier ? TIER_ORDER.indexOf(fromTier) : -1;
	const tiers = data.filter((cap) => {
		if (fromIdx < 0) return true;
		const idx = TIER_ORDER.indexOf(cap.tier);
		return idx >= 0 && idx > fromIdx; // strictly above current
	});
	if (tiers.length === 0) return null;

	const rows = compact
		? ([
				{ label: "Price", render: fmtPrice },
				{ label: "Seats", render: fmtSeats },
				{ label: "Hours", render: fmtHours },
				{ label: "Hour overage", render: fmtHourOverage },
				{ label: "Guests", render: fmtGuests },
			] as const)
		: ([
				{ label: "Price", render: fmtPrice },
				{ label: "Duration", render: (c: TierCapacity) => c.duration },
				{ label: "Seats", render: fmtSeats },
				{ label: "Seat overage", render: fmtSeatOverage },
				{ label: "Hours", render: fmtHours },
				{ label: "Hour overage", render: fmtHourOverage },
				{ label: "Guests", render: fmtGuests },
				{
					label: "Training",
					render: (c: TierCapacity) => c.training_included,
				},
			] as const);

	return (
		<Paper withBorder radius="sm" p={compact ? "xs" : "md"}>
			<Table verticalSpacing="xs" striped>
				<Table.Thead>
					<Table.Tr>
						<Table.Th />
						{tiers.map((cap) => {
							const isHighlight = cap.tier === highlightTier;
							return (
								<Table.Th
									key={cap.tier}
									style={{
										textAlign: "left",
										background: isHighlight ? "rgba(65,105,225,0.08)" : undefined,
										borderTop: isHighlight
											? "2px solid #4169e1"
											: undefined,
									}}
								>
									<Stack gap={0}>
										<Text
											size="sm"
											fw={500}
											style={{ textTransform: "capitalize" }}
										>
											{cap.tier}
										</Text>
										<Text size="xs" c="dimmed" fw={400}>
											— {cap.tagline}
										</Text>
									</Stack>
								</Table.Th>
							);
						})}
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{rows.map((row) => (
						<Table.Tr key={row.label}>
							<Table.Td>
								<Text size="xs" c="dimmed">
									<Trans id={row.label}>{row.label}</Trans>
								</Text>
							</Table.Td>
							{tiers.map((cap) => (
								<Table.Td
									key={cap.tier}
									style={{
										background:
											cap.tier === highlightTier
												? "rgba(65,105,225,0.04)"
												: undefined,
									}}
								>
									<Text size="xs">{row.render(cap)}</Text>
								</Table.Td>
							))}
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
			{compact && (
				<Box mt={4}>
					<Text size="xs" c="dimmed" ta="right">
						<Trans>∞ = unlimited subject to plan</Trans>
					</Text>
				</Box>
			)}
		</Paper>
	);
};
