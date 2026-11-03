import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Paper,
	SegmentedControl,
	SimpleGrid,
	Skeleton,
	Stack,
	Table,
	Text,
	Title,
} from "@mantine/core";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Fragment, useMemo, useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import {
	type AiBudgetOverride,
	type AiCostAccount,
	formatMicroEur,
	useAiCosts,
} from "@/hooks/useAiCosts";

const COLUMNS = 7;

const featureName = (operation: string) => operation || t`Unlabelled`;

// The instant the month's budgets were judged at: now, or the end of a past month.
const judgedAt = (periodStart: string): Date => {
	const start = new Date(periodStart);
	const end = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
	);
	const now = new Date();
	return end > now ? now : new Date(end.getTime() - 1);
};

function BudgetCell({
	account,
	override,
	at,
}: {
	account: AiCostAccount;
	override: AiBudgetOverride | undefined;
	at: Date;
}) {
	if (account.unlimited)
		return (
			<Badge size="xs" color="gray" variant="light">
				<Trans>No limit</Trans>
			</Badge>
		);
	if (account.budget_micro_eur === null)
		return (
			<Text size="xs" c="dimmed">
				-
			</Text>
		);
	const custom =
		override?.amount_micro_eur != null &&
		(override.until === null || new Date(override.until) > at);
	if (override && !custom)
		return (
			<Stack gap={0}>
				<Text size="xs">
					<Trans>Default</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					{formatMicroEur(account.budget_micro_eur)}
				</Text>
			</Stack>
		);
	return <Text size="xs">{formatMicroEur(account.budget_micro_eur)}</Text>;
}

function CostList({
	title,
	items,
}: {
	title: string;
	items: { name: string; cost: number }[];
}) {
	return (
		<Stack gap={4}>
			<Text size="xs" fw={600}>
				{title}
			</Text>
			{items.map((item) => (
				<Group key={item.name} justify="space-between" wrap="nowrap" gap="sm">
					<Text size="xs" truncate>
						{item.name}
					</Text>
					<Text size="xs">{formatMicroEur(item.cost)}</Text>
				</Group>
			))}
		</Stack>
	);
}

function Stat({
	label,
	value,
	testId,
}: {
	label: string;
	value: number;
	testId: string;
}) {
	return (
		<Paper withBorder p="sm">
			<Text size="xs" c="dimmed" tt="capitalize">
				{label}
			</Text>
			<Text size="lg" fw={600} data-testid={testId}>
				{formatMicroEur(value)}
			</Text>
		</Paper>
	);
}

/** Staff view of AI cost per billing account, every tier, in euros. */
export function AiCostsPanel({
	onOpenAccount,
	overrides,
}: {
	onOpenAccount?: (billingAccountId: string) => void;
	// The accounts' own overrides, to tell a custom budget from the default.
	overrides?: ReadonlyMap<string, AiBudgetOverride>;
}) {
	const { i18n } = useLingui();
	const [offset, setOffset] = useState<0 | 1>(0);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const { data, error, isLoading, refetch } = useAiCosts(offset);

	const accounts = useMemo(
		() =>
			[...(data?.accounts ?? [])].sort(
				(a, b) => b.cost_micro_eur - a.cost_micro_eur,
			),
		[data],
	);
	const total = useMemo(
		() => (data?.by_provider ?? []).reduce((s, p) => s + p.cost_micro_eur, 0),
		[data],
	);
	const at = data ? judgedAt(data.period_start) : new Date();
	const month = data
		? new Date(data.period_start).toLocaleDateString(i18n.locale, {
				month: "long",
				timeZone: "UTC",
				year: "numeric",
			})
		: "";

	return (
		<Stack gap="sm">
			<Group justify="space-between" align="flex-end" wrap="wrap">
				<Stack gap={2}>
					<Title order={4}>
						<Trans>AI costs</Trans>
					</Title>
					<Text size="xs" c="dimmed">
						<Trans>
							Every AI call on every tier, priced in euros. Free accounts show
							their budget.
						</Trans>
					</Text>
				</Stack>
				<SegmentedControl
					size="xs"
					value={String(offset)}
					onChange={(v) => setOffset(v === "1" ? 1 : 0)}
					data={[
						{ label: t`This month`, value: "0" },
						{ label: t`Last month`, value: "1" },
					]}
				/>
			</Group>
			{isLoading ? (
				<Skeleton h={320} />
			) : !data ? (
				<ErrorNotice
					error={error ?? new Error("ai costs unavailable")}
					onRetry={() => void refetch()}
					title={t`Could not load the AI costs.`}
				/>
			) : (
				<>
					<Text size="sm" fw={500}>
						{month}
					</Text>
					<SimpleGrid
						cols={{ base: 2, sm: 4 }}
						spacing="xs"
						data-testid="ai-cost-summary"
					>
						<Stat label={t`Total`} value={total} testId="ai-cost-total" />
						<Stat
							label={t`Unattributed`}
							value={data.unattributed_micro_eur}
							testId="ai-cost-unattributed"
						/>
						{data.by_provider.map((p) => (
							<Stat
								key={p.provider}
								label={p.provider}
								value={p.cost_micro_eur}
								testId={`ai-cost-provider-${p.provider}`}
							/>
						))}
					</SimpleGrid>
					{accounts.length === 0 ? (
						<Text size="sm" c="dimmed">
							<Trans>No AI costs recorded this month.</Trans>
						</Text>
					) : (
						<Paper withBorder>
							<Table.ScrollContainer minWidth={760}>
								<Table verticalSpacing="xs" fz="xs" highlightOnHover>
									<Table.Thead>
										<Table.Tr>
											<Table.Th style={{ width: 36 }} />
											<Table.Th>
												<Trans>Account</Trans>
											</Table.Th>
											<Table.Th>
												<Trans>Tier</Trans>
											</Table.Th>
											<Table.Th style={{ textAlign: "right" }}>
												<Trans>Cost</Trans>
											</Table.Th>
											<Table.Th>
												<Trans>Budget</Trans>
											</Table.Th>
											<Table.Th style={{ textAlign: "right" }}>
												<Trans>Used</Trans>
											</Table.Th>
											<Table.Th>
												<Trans>Top features</Trans>
											</Table.Th>
										</Table.Tr>
									</Table.Thead>
									<Table.Tbody>
										{accounts.map((a) => {
											const id = a.billing_account_id;
											const open = expanded[id] ?? false;
											return (
												<Fragment key={id}>
													<Table.Tr
														data-testid={`ai-cost-row-${id}`}
														onClick={() => onOpenAccount?.(id)}
														style={{
															cursor: onOpenAccount ? "pointer" : undefined,
														}}
													>
														<Table.Td>
															<ActionIcon
																variant="subtle"
																color="gray"
																aria-label={t`Show breakdown`}
																aria-expanded={open}
																onClick={(e) => {
																	e.stopPropagation();
																	setExpanded((x) => ({ ...x, [id]: !open }));
																}}
															>
																{open ? (
																	<CaretDownIcon size={18} />
																) : (
																	<CaretRightIcon size={18} />
																)}
															</ActionIcon>
														</Table.Td>
														<Table.Td>
															<Text size="xs" truncate maw={240}>
																{a.name || id}
															</Text>
														</Table.Td>
														<Table.Td>
															<Badge
																size="xs"
																color="gray"
																variant="light"
																tt="capitalize"
															>
																{a.tier ?? "-"}
															</Badge>
														</Table.Td>
														<Table.Td style={{ textAlign: "right" }}>
															<Text size="xs">
																{formatMicroEur(a.cost_micro_eur)}
															</Text>
														</Table.Td>
														<Table.Td>
															<BudgetCell
																account={a}
																override={overrides?.get(id)}
																at={at}
															/>
														</Table.Td>
														<Table.Td style={{ textAlign: "right" }}>
															<Text size="xs">
																{a.percent_used === null
																	? "-"
																	: `${a.percent_used}%`}
															</Text>
														</Table.Td>
														<Table.Td>
															<Text size="xs" c="dimmed">
																{a.by_feature
																	.slice(0, 3)
																	.map(
																		(f) =>
																			`${featureName(f.operation)} ${formatMicroEur(f.cost_micro_eur)}`,
																	)
																	.join(", ")}
															</Text>
														</Table.Td>
													</Table.Tr>
													{open && (
														<Table.Tr data-testid={`ai-cost-detail-${id}`}>
															<Table.Td colSpan={COLUMNS}>
																<SimpleGrid
																	cols={{ base: 1, sm: 2 }}
																	spacing="lg"
																	px="xl"
																	py="xs"
																>
																	<CostList
																		title={t`By feature`}
																		items={a.by_feature.map((f) => ({
																			cost: f.cost_micro_eur,
																			name: featureName(f.operation),
																		}))}
																	/>
																	<CostList
																		title={t`By model`}
																		items={a.by_model.map((m) => ({
																			cost: m.cost_micro_eur,
																			name: m.model,
																		}))}
																	/>
																</SimpleGrid>
															</Table.Td>
														</Table.Tr>
													)}
												</Fragment>
											);
										})}
									</Table.Tbody>
								</Table>
							</Table.ScrollContainer>
						</Paper>
					)}
				</>
			)}
		</Stack>
	);
}
