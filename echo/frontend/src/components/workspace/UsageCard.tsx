import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Divider,
	Group,
	Paper,
	Progress,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

interface ProjectUsage {
	id: string;
	name: string;
	audio_hours: number;
	conversation_count: number;
}

interface UsageResponse {
	cycle_start: string;
	cycle_end_exclusive: string;
	tier: string;
	tier_tagline: string;
	audio_hours: number;
	audio_hours_included: number | null;
	seat_count: number;
	seat_count_included: number | null;
	guest_count: number;
	guest_cap: number | null;
	project_count: number;
	projects: ProjectUsage[];
	pilot_hard_block_active: boolean;
	overage_forecast_eur?: number | null;
	seat_overage_eur?: number | null;
	next_tier?: {
		tier: string;
		tagline: string;
		price_eur_monthly: number | null;
		price_note: string;
		included_hours: number | null;
		included_seats: number | null;
	} | null;
}

async function fetchUsage(workspaceId: string): Promise<UsageResponse | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return res.json();
}

function formatCycleMonth(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatEur(value: number | null | undefined): string {
	if (value == null) return "—";
	if (value === 0) return "€0";
	return `€${Math.round(value)}`;
}

/**
 * Workspace usage card (matrix v1.1 §8).
 *
 * Role-aware rendering:
 *   - Member: hours / seats / guests / projects, raw numbers.
 *   - Admin + Billing: adds overage forecast and next-tier recommendation.
 *
 * Source fields come pre-differentiated from the backend (next_tier +
 * overage_forecast_eur are null for members — `workspace:view_invoices`
 * gates them server-side).
 */
export const UsageCard = ({ workspaceId }: { workspaceId: string }) => {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "workspace-usage", workspaceId],
		queryFn: () => fetchUsage(workspaceId),
		staleTime: 60_000,
	});

	if (isLoading || !data) return null;

	const hoursPct =
		data.audio_hours_included && data.audio_hours_included > 0
			? Math.min(100, (data.audio_hours / data.audio_hours_included) * 100)
			: null;

	const seatsPct =
		data.seat_count_included && data.seat_count_included > 0
			? Math.min(100, (data.seat_count / data.seat_count_included) * 100)
			: null;

	const pilotExhausted = data.pilot_hard_block_active;
	const approachingCap = hoursPct !== null && hoursPct >= 80 && hoursPct < 100;

	return (
		<Paper p="lg" withBorder radius="sm">
			<Stack gap={16}>
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Title order={5} fw={400}>
							<Trans>Usage · {formatCycleMonth(data.cycle_start)}</Trans>
						</Title>
						{data.tier_tagline && (
							<Text size="xs" c="dimmed">
								<span style={{ textTransform: "capitalize" }}>{data.tier}</span>
								{" — "}
								{data.tier_tagline}
							</Text>
						)}
					</Stack>
					{pilotExhausted && (
						<Badge size="sm" color="red" variant="light">
							<Trans>At limit</Trans>
						</Badge>
					)}
					{!pilotExhausted && approachingCap && (
						<Badge size="sm" color="yellow" variant="light">
							<Trans>Approaching limit</Trans>
						</Badge>
					)}
				</Group>

				{/* Audio hours */}
				<Stack gap={6}>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							<Trans>Audio hours</Trans>
						</Text>
						<Text size="sm">
							{data.audio_hours.toFixed(1)}
							{data.audio_hours_included != null && (
								<Text span c="dimmed" size="sm">
									{" / "}
									{data.audio_hours_included}
								</Text>
							)}
						</Text>
					</Group>
					{hoursPct !== null && (
						<Progress
							value={hoursPct}
							size="xs"
							color={pilotExhausted ? "red" : approachingCap ? "yellow" : "blue"}
						/>
					)}
				</Stack>

				{/* Seats */}
				<Stack gap={6}>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							<Trans>Seats</Trans>
						</Text>
						<Text size="sm">
							{data.seat_count}
							{data.seat_count_included != null && (
								<Text span c="dimmed" size="sm">
									{" / "}
									{data.seat_count_included}
								</Text>
							)}
						</Text>
					</Group>
					{seatsPct !== null && (
						<Progress value={seatsPct} size="xs" color="blue" />
					)}
				</Stack>

				{/* Guests + projects (compact row) */}
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						<Trans>Guests</Trans>
					</Text>
					<Text size="sm">
						{data.guest_count}
						{data.guest_cap != null && (
							<Text span c="dimmed" size="sm">
								{" / "}
								{data.guest_cap}
							</Text>
						)}
					</Text>
				</Group>
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						<Trans>Projects</Trans>
					</Text>
					<Text size="sm">{data.project_count}</Text>
				</Group>

				{/* Admin / billing: financial forecast */}
				{(data.overage_forecast_eur != null || data.next_tier) && (
					<>
						<Divider />
						<Stack gap={8}>
							{data.overage_forecast_eur != null && (
								<Group justify="space-between">
									<Text size="sm" c="dimmed">
										<Trans>Overage forecast this month</Trans>
									</Text>
									<Text size="sm">{formatEur(data.overage_forecast_eur)}</Text>
								</Group>
							)}
							{data.seat_overage_eur != null && data.seat_overage_eur > 0 && (
								<Group justify="space-between">
									<Text size="sm" c="dimmed">
										<Trans>Extra-seat cost</Trans>
									</Text>
									<Text size="sm">{formatEur(data.seat_overage_eur)}</Text>
								</Group>
							)}
							{data.next_tier && (
								<Text size="xs" c="dimmed">
									<Trans>
										Next tier: {data.next_tier.tier} — {data.next_tier.tagline}
									</Trans>
									{data.next_tier.price_eur_monthly != null && (
										<>
											{" "}
											<Anchor
												component="a"
												href="?tab=billing#request-upgrade"
												size="xs"
											>
												<Trans>
													{formatEur(data.next_tier.price_eur_monthly)}
													/mo · see what's included
												</Trans>
											</Anchor>
										</>
									)}
								</Text>
							)}
						</Stack>
					</>
				)}
			</Stack>
		</Paper>
	);
};
