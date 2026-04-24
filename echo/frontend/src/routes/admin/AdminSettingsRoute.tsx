import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Tabs,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconAlertTriangle, IconDownload, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";

type BillingContact = {
	user_id: string | null;
	display_name: string | null;
	email: string | null;
};

type BillingRow = {
	workspace_id: string;
	workspace_name: string;
	org_id: string;
	org_name: string;
	tier: string;
	is_partner_owned: boolean;
	billed_to_team_id: string | null;
	billed_to_team_name: string | null;
	audio_hours: number;
	audio_hours_included: number | null;
	hours_pct: number | null;
	over_hours: number;
	hour_overage_eur: number;
	seat_count: number;
	seats_included: number | null;
	over_seats: number;
	seat_overage_eur: number;
	base_price_eur: number | null;
	total_forecast_eur: number | null;
	pilot_hard_block: boolean;
	approaching_cap: boolean;
	at_cap: boolean;
	downgraded_at: string | null;
	downgraded_from_tier: string | null;
	billing_contacts: BillingContact[];
};

type BillingRollup = {
	cycle_start: string;
	cycle_end_exclusive: string;
	workspace_count: number;
	total_base_eur: number;
	total_overage_eur: number;
	total_forecast_eur: number;
	rows: BillingRow[];
};

type AtRiskRow = {
	workspace_id: string;
	workspace_name: string;
	org_id: string;
	org_name: string;
	tier: string;
	reason: "pilot_hard_block" | "at_cap" | "approaching_cap" | "recently_downgraded";
	detail: string;
};

async function fetchRollup(): Promise<BillingRollup | null> {
	const res = await fetch(`${API_BASE_URL}/v2/admin/billing-rollup`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function fetchAtRisk(): Promise<AtRiskRow[]> {
	const res = await fetch(`${API_BASE_URL}/v2/admin/at-risk`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

const formatEur = (n: number | null | undefined) => {
	if (n == null) return "—";
	if (n === 0) return "€0";
	return `€${Math.round(n).toLocaleString()}`;
};

const tierColors: Record<string, string> = {
	pilot: "gray",
	pioneer: "blue",
	innovator: "violet",
	changemaker: "grape",
	guardian: "orange",
};

/**
 * CSV download of the billing rollup. Staff uses this to hand rows
 * to finance for invoicing. Opens as a blob so we don't need a
 * server-side endpoint just for the download.
 */
function downloadRollupCsv(rollup: BillingRollup) {
	const headers = [
		"workspace_id",
		"workspace_name",
		"org_name",
		"tier",
		"billed_to",
		"audio_hours",
		"audio_hours_included",
		"over_hours",
		"hour_overage_eur",
		"seat_count",
		"seats_included",
		"over_seats",
		"seat_overage_eur",
		"base_price_eur",
		"total_forecast_eur",
		"contact_email_primary",
	];
	const rows = rollup.rows.map((r) => [
		r.workspace_id,
		r.workspace_name,
		r.org_name,
		r.tier,
		r.billed_to_team_name ?? r.org_name,
		r.audio_hours.toFixed(2),
		r.audio_hours_included ?? "",
		r.over_hours.toFixed(2),
		r.hour_overage_eur.toFixed(2),
		r.seat_count,
		r.seats_included ?? "",
		r.over_seats,
		r.seat_overage_eur.toFixed(2),
		r.base_price_eur ?? "",
		r.total_forecast_eur ?? "",
		r.billing_contacts[0]?.email ?? "",
	]);
	const csv = [
		headers.join(","),
		...rows.map((r) =>
			r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","),
		),
	].join("\n");
	const blob = new Blob([csv], { type: "text/csv" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `billing-rollup-${rollup.cycle_start.slice(0, 7)}.csv`;
	link.click();
	URL.revokeObjectURL(url);
}

function BillingPanel() {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "admin", "billing-rollup"],
		queryFn: fetchRollup,
		staleTime: 60_000,
	});
	const [search, setSearch] = useState("");
	const [onlyOver, setOnlyOver] = useState(false);

	const filtered = useMemo(() => {
		const rows = data?.rows ?? [];
		const q = search.trim().toLowerCase();
		return rows.filter((r) => {
			if (onlyOver && r.hour_overage_eur === 0 && r.seat_overage_eur === 0)
				return false;
			if (!q) return true;
			return (
				r.workspace_name.toLowerCase().includes(q) ||
				r.org_name.toLowerCase().includes(q) ||
				r.tier.toLowerCase().includes(q) ||
				r.billing_contacts.some((c) =>
					(c.email || "").toLowerCase().includes(q),
				)
			);
		});
	}, [data, search, onlyOver]);

	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" color="gray" />
			</Center>
		);
	}
	if (!data) {
		return (
			<Text c="red" size="sm">
				<Trans>Couldn't load the rollup. Check auth + backend logs.</Trans>
			</Text>
		);
	}

	const cycleLabel = new Date(data.cycle_start).toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
	});

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center" wrap="wrap">
				<Stack gap={2}>
					<Text size="sm" c="dimmed">
						<Trans>
							Billing rollup · {cycleLabel} ·{" "}
							<Plural
								value={data.workspace_count}
								one="# workspace"
								other="# workspaces"
							/>
						</Trans>
					</Text>
					<Group gap="md">
						<Text size="xs" c="dimmed">
							<Trans>Base</Trans> {formatEur(data.total_base_eur)}
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>Overage</Trans> {formatEur(data.total_overage_eur)}
						</Text>
						<Text size="sm" fw={500}>
							<Trans>Total forecast</Trans>{" "}
							{formatEur(data.total_forecast_eur)}
						</Text>
					</Group>
				</Stack>
				<Group gap="xs">
					<Button
						size="xs"
						variant="default"
						leftSection={<IconDownload size={14} />}
						onClick={() => downloadRollupCsv(data)}
					>
						<Trans>Export CSV</Trans>
					</Button>
				</Group>
			</Group>

			<Group gap="sm" wrap="wrap">
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search workspace, team, email, tier`}
					value={search}
					onChange={(e) => setSearch(e.currentTarget.value)}
					size="sm"
					style={{ flex: 1, maxWidth: 360 }}
				/>
				<Button
					size="xs"
					variant={onlyOver ? "filled" : "default"}
					color={onlyOver ? "red" : "gray"}
					onClick={() => setOnlyOver((v) => !v)}
				>
					<Trans>Over-cap only</Trans>
				</Button>
			</Group>

			<Paper withBorder radius="sm" style={{ overflowX: "auto" }}>
				<Table striped highlightOnHover verticalSpacing="xs" fz="xs">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Workspace</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Team</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Tier</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Hours</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Seats</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Base</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Overage</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Total</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Contact</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Status</Trans>
							</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{filtered.map((r) => {
							const hours = r.audio_hours_included
								? `${r.audio_hours.toFixed(1)} / ${r.audio_hours_included}`
								: r.audio_hours.toFixed(1);
							const seats = r.seats_included
								? `${r.seat_count} / ${r.seats_included}`
								: `${r.seat_count}`;
							const overage = r.hour_overage_eur + r.seat_overage_eur;
							return (
								<Table.Tr key={r.workspace_id}>
									<Table.Td>
										<Anchor
											component={I18nLink}
											to={`/w/${r.workspace_id}/settings/billing`}
											size="xs"
											fw={500}
										>
											{r.workspace_name}
										</Anchor>
									</Table.Td>
									<Table.Td>
										<Anchor
											component={I18nLink}
											to={`/t/${r.org_id}`}
											size="xs"
											c="dimmed"
										>
											{r.billed_to_team_name ?? r.org_name}
										</Anchor>
										{r.is_partner_owned && (
											<Badge ml={4} size="xs" color="violet" variant="light">
												<Trans>partner</Trans>
											</Badge>
										)}
									</Table.Td>
									<Table.Td>
										<Badge
											size="xs"
											color={tierColors[r.tier] ?? "gray"}
											variant="light"
											tt="capitalize"
										>
											{r.tier}
										</Badge>
									</Table.Td>
									<Table.Td ta="right">
										<Text
											size="xs"
											c={r.at_cap || r.pilot_hard_block ? "red" : undefined}
										>
											{hours}
										</Text>
									</Table.Td>
									<Table.Td ta="right">{seats}</Table.Td>
									<Table.Td ta="right">{formatEur(r.base_price_eur)}</Table.Td>
									<Table.Td ta="right">
										<Text
											size="xs"
											c={overage > 0 ? "orange" : "dimmed"}
										>
											{formatEur(overage)}
										</Text>
									</Table.Td>
									<Table.Td ta="right" fw={500}>
										{formatEur(r.total_forecast_eur)}
									</Table.Td>
									<Table.Td>
										{r.billing_contacts.length === 0 ? (
											<Text size="xs" c="dimmed">
												—
											</Text>
										) : (
											<Tooltip
												label={r.billing_contacts
													.map((c) => `${c.display_name ?? "?"} · ${c.email ?? "—"}`)
													.join(" · ")}
												withArrow
											>
												<Text size="xs" c="dimmed" truncate maw={160}>
													{r.billing_contacts[0].email ?? "—"}
												</Text>
											</Tooltip>
										)}
									</Table.Td>
									<Table.Td>
										<Group gap={4} wrap="nowrap">
											{r.pilot_hard_block && (
												<Badge size="xs" color="red" variant="filled">
													<Trans>blocked</Trans>
												</Badge>
											)}
											{r.at_cap && !r.pilot_hard_block && (
												<Badge size="xs" color="red" variant="light">
													<Trans>at cap</Trans>
												</Badge>
											)}
											{r.approaching_cap && (
												<Badge size="xs" color="yellow" variant="light">
													<Trans>near cap</Trans>
												</Badge>
											)}
											{r.downgraded_at && (
												<Badge size="xs" color="gray" variant="light">
													<Trans>downgraded</Trans>
												</Badge>
											)}
										</Group>
									</Table.Td>
								</Table.Tr>
							);
						})}
						{filtered.length === 0 && (
							<Table.Tr>
								<Table.Td colSpan={10}>
									<Text size="xs" c="dimmed" ta="center" py="md">
										<Trans>Nothing matches the filter.</Trans>
									</Text>
								</Table.Td>
							</Table.Tr>
						)}
					</Table.Tbody>
				</Table>
			</Paper>
		</Stack>
	);
}

function AtRiskPanel() {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "admin", "at-risk"],
		queryFn: fetchAtRisk,
		staleTime: 60_000,
	});
	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" color="gray" />
			</Center>
		);
	}
	const rows = data ?? [];
	if (rows.length === 0) {
		return (
			<Paper withBorder radius="sm" p="xl">
				<Center>
					<Text size="sm" c="dimmed">
						<Trans>Nothing flagged. Everyone's within caps.</Trans>
					</Text>
				</Center>
			</Paper>
		);
	}

	const reasonColor: Record<AtRiskRow["reason"], string> = {
		pilot_hard_block: "red",
		at_cap: "red",
		approaching_cap: "yellow",
		recently_downgraded: "gray",
	};
	const reasonLabel: Record<AtRiskRow["reason"], string> = {
		pilot_hard_block: t`Pilot blocked`,
		at_cap: t`At cap`,
		approaching_cap: t`Approaching cap`,
		recently_downgraded: t`Recently downgraded`,
	};

	return (
		<Stack gap="sm">
			{rows.map((r, i) => (
				<Paper key={`${r.workspace_id}-${r.reason}-${i}`} withBorder radius="sm" p="md">
					<Group justify="space-between" align="flex-start" wrap="nowrap">
						<Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
							<Group gap="xs" wrap="nowrap">
								<IconAlertTriangle
									size={14}
									color={`var(--mantine-color-${reasonColor[r.reason]}-6)`}
								/>
								<Badge size="xs" color={reasonColor[r.reason]} variant="light">
									{reasonLabel[r.reason]}
								</Badge>
								<Anchor
									component={I18nLink}
									to={`/w/${r.workspace_id}/settings/billing`}
									size="sm"
									fw={500}
								>
									{r.workspace_name}
								</Anchor>
								<Text size="xs" c="dimmed">
									· {r.org_name}
								</Text>
								<Badge
									size="xs"
									color={tierColors[r.tier] ?? "gray"}
									variant="light"
									tt="capitalize"
								>
									{r.tier}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed">
								{r.detail}
							</Text>
						</Stack>
					</Group>
				</Paper>
			))}
		</Stack>
	);
}

function PartnersPanel() {
	return (
		<Paper withBorder radius="sm" p="xl">
			<Stack align="center" gap={8}>
				<Text size="sm" fw={500}>
					<Trans>Referral ledger browser</Trans>
				</Text>
				<Text size="xs" c="dimmed" ta="center" maw={420}>
					<Trans>
						Read the ledger directly in Directus for now — the ledger UI is
						queued for a follow-up. Schema lives under `referral_ledger`.
					</Trans>
				</Text>
			</Stack>
		</Paper>
	);
}

function UpgradesPanel() {
	return (
		<Paper withBorder radius="sm" p="xl">
			<Stack align="center" gap={8}>
				<Text size="sm" fw={500}>
					<Trans>Upgrade requests</Trans>
				</Text>
				<Text size="xs" c="dimmed" ta="center" maw={420}>
					<Trans>
						Upgrade requests currently email upgrades@dembrane.com. Inline
						triage queue is queued for a follow-up.
					</Trans>
				</Text>
			</Stack>
		</Paper>
	);
}

export const AdminSettingsRoute = () => {
	useDocumentTitle(t`Admin · dembrane`);
	const { data: me } = useV2Me();
	const { tab } = useParams();
	const navigate = useNavigate();

	if (me && me.is_staff !== true) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" gap="sm" mt="15vh">
					<Title order={3} fw={400}>
						<Trans>Staff only</Trans>
					</Title>
					<Text c="dimmed" size="sm" ta="center">
						<Trans>
							This area is for dembrane staff. If you think you should have
							access, email support@dembrane.com.
						</Trans>
					</Text>
				</Stack>
			</Container>
		);
	}

	const active = (tab as string) || "billing";

	return (
		<Container size="xl" py="xl" px="lg">
			<Stack gap="md">
				<Group justify="space-between" align="flex-end">
					<Stack gap={2}>
						<Group gap="xs" align="center">
							<Title order={3} fw={400}>
								<Trans>Admin</Trans>
							</Title>
							<Badge size="xs" color="violet" variant="light">
								<Trans>Staff</Trans>
							</Badge>
						</Group>
						<Text size="xs" c="dimmed">
							<Trans>
								Invoicing, at-risk watch, partner ledger, upgrade triage. Any
								Directus admin has access — staff policy wiring (matrix §11)
								lands in a follow-up.
							</Trans>
						</Text>
					</Stack>
				</Group>
				<Tabs
					value={active}
					onChange={(v) => v && navigate(`/admin/${v}`, { replace: true })}
					keepMounted={false}
				>
					<Tabs.List>
						<Tabs.Tab value="billing">
							<Trans>Billing</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="at-risk">
							<Trans>At risk</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="partners">
							<Trans>Partners</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="upgrades">
							<Trans>Upgrades</Trans>
						</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value="billing" pt="md">
						<BillingPanel />
					</Tabs.Panel>
					<Tabs.Panel value="at-risk" pt="md">
						<AtRiskPanel />
					</Tabs.Panel>
					<Tabs.Panel value="partners" pt="md">
						<PartnersPanel />
					</Tabs.Panel>
					<Tabs.Panel value="upgrades" pt="md">
						<UpgradesPanel />
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</Container>
	);
};
