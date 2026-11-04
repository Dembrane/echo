import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Group,
	Progress,
	SegmentedControl,
	SimpleGrid,
	Skeleton,
	Stack,
	Table,
	Text,
	Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	CaretDownIcon,
	CaretRightIcon,
	DotsThreeIcon,
} from "@phosphor-icons/react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { type AiCostAccount, useAiCosts } from "@/hooks/useAiCosts";
import {
	formatAiCost,
	formatShare,
	type GroupCost,
	groupFeatures,
} from "./aiCostBreakdown";

const COLUMNS = 7;

const nowrap = { whiteSpace: "nowrap" } as const;

const formatUntil = (iso: string, locale: string) =>
	new Date(iso).toLocaleDateString(locale, {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
		year: "numeric",
	});

const tierName = (tier: string | null) =>
	tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : t`No tier`;

function accountContext(a: AiCostAccount): string {
	const tier = tierName(a.tier);
	if (a.account_scope === "organisation")
		return t`${tier}, organisation account`;
	if (a.account_scope === "workspace") return t`${tier}, workspace account`;
	return tier;
}

function budgetLine(a: AiCostAccount, locale: string): string {
	const until = a.override_until ? formatUntil(a.override_until, locale) : null;
	if (a.unlimited) return until ? t`No limit until ${until}` : t`No limit`;
	if (a.budget_micro_eur === null) return t`Paid plan`;
	const amount = formatAiCost(a.budget_micro_eur);
	if (!a.custom_budget) return t`${amount} default`;
	return until ? t`${amount} until ${until}` : t`${amount} custom`;
}

function UsedCell({ percent }: { percent: number | null }) {
	if (percent === null)
		return (
			<Text size="xs" c="dimmed">
				-
			</Text>
		);
	const color = percent >= 100 ? "red" : percent >= 80 ? "yellow" : "primary";
	return (
		<Group gap="xs" wrap="nowrap">
			<Progress
				value={Math.min(100, percent)}
				color={color}
				size="sm"
				w={72}
				aria-hidden
			/>
			<Text size="xs" c={percent >= 100 ? "red" : undefined}>
				{`${percent}%`}
			</Text>
		</Group>
	);
}

// One breakdown line: name, calls, cost, share, and a bar unless `bar` is unset.
function ShareLine({
	name,
	secondary,
	calls,
	cost,
	share,
	bar,
	testId,
}: {
	name: string;
	secondary?: ReactNode;
	calls?: number;
	cost: number;
	share: number;
	bar?: "thick" | "thin";
	testId?: string;
}) {
	const strong = bar === "thick";
	const size = strong ? "sm" : "xs";
	return (
		<Stack gap={2} data-testid={testId}>
			<Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
				<Stack gap={0} style={{ minWidth: 0 }}>
					<Text size={size} fw={strong ? 600 : undefined} truncate title={name}>
						{name}
					</Text>
					{secondary}
				</Stack>
				<Group gap="md" wrap="nowrap" style={{ flexShrink: 0 }}>
					{calls !== undefined && (
						<Text size="xs" c="dimmed" style={nowrap}>
							<Plural value={calls} one="# call" other="# calls" />
						</Text>
					)}
					<Text size={size} fw={strong ? 600 : undefined} style={nowrap}>
						{formatAiCost(cost)}
					</Text>
					<Text size="xs" c="dimmed" w={36} ta="right">
						{formatShare(share)}
					</Text>
				</Group>
			</Group>
			{bar && (
				<Progress value={share * 100} size={strong ? 4 : 2} aria-hidden />
			)}
		</Stack>
	);
}

function GroupBlock({ group }: { group: GroupCost }) {
	return (
		<Stack gap={6} data-testid={`ai-cost-group-${group.group}`}>
			<ShareLine
				name={group.label}
				calls={group.calls}
				cost={group.cost_micro_eur}
				share={group.share}
				bar="thick"
			/>
			<Stack gap={6} pl="md">
				{group.operations.map((op) => (
					<ShareLine
						key={op.operation}
						name={op.label}
						secondary={
							op.operation && op.label !== op.operation ? (
								<Text
									size="xs"
									c="dimmed"
									ff="monospace"
									fz={11}
									truncate
									title={op.operation}
								>
									{op.operation}
								</Text>
							) : undefined
						}
						cost={op.cost_micro_eur}
						share={op.share}
					/>
				))}
			</Stack>
		</Stack>
	);
}

function Breakdown({ account }: { account: AiCostAccount }) {
	const groups = groupFeatures(account.by_feature);
	const total = account.by_model.reduce((s, m) => s + m.cost_micro_eur, 0);
	return (
		<SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl" px="md" py="sm">
			<Stack gap="sm">
				<Text size="xs" fw={600} tt="uppercase" c="dimmed">
					<Trans>By feature group</Trans>
				</Text>
				{groups.map((g) => (
					<GroupBlock key={g.group} group={g} />
				))}
			</Stack>
			<Stack gap="sm">
				<Text size="xs" fw={600} tt="uppercase" c="dimmed">
					<Trans>By model</Trans>
				</Text>
				{account.by_model.map((m) => (
					<ShareLine
						key={`${m.model} ${m.provider}`}
						testId={`ai-cost-model-${m.provider}-${m.model}`}
						name={m.model}
						secondary={
							<Text size="xs" c="dimmed">
								{m.provider}
							</Text>
						}
						calls={m.calls}
						cost={m.cost_micro_eur}
						share={total > 0 ? m.cost_micro_eur / total : 0}
						bar="thin"
					/>
				))}
			</Stack>
		</SimpleGrid>
	);
}

function Stat({
	label,
	value,
	caption,
	testId,
}: {
	label: string;
	value: string;
	caption: string;
	testId: string;
}) {
	return (
		<Box p="sm" style={tileStyle}>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text size="lg" fw={600} data-testid={testId}>
				{value}
			</Text>
			<Text size="xs" c="dimmed">
				{caption}
			</Text>
		</Box>
	);
}

const LINE = "var(--mantine-color-default-border)";

// Tiles grow to fill each line; their left and top lines are clipped at the strip's edge.
const tileStyle = {
	boxShadow: `-1px 0 0 ${LINE}, 0 -1px 0 ${LINE}`,
	flex: "1 1 200px",
	minWidth: 0,
} as const;

// Single top and bottom rule; children draw their own top rule, clipped on the first line.
const stripStyle = {
	borderBottom: `1px solid ${LINE}`,
	borderTop: `1px solid ${LINE}`,
	display: "flex",
	flexWrap: "wrap",
	overflow: "hidden",
} as const;

// One labelled row of tiles with a single top and bottom border.
function Strip({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Stack gap={4}>
			<Text size="xs" fw={600} tt="uppercase" c="dimmed">
				{title}
			</Text>
			<Box style={stripStyle}>{children}</Box>
		</Stack>
	);
}

type RowProps = {
	account: AiCostAccount;
	open: boolean;
	onToggle: () => void;
	onOpenAccount?: (billingAccountId: string) => void;
};

function ToggleButton({ open, onToggle }: Pick<RowProps, "open" | "onToggle">) {
	return (
		<ActionIcon
			variant="subtle"
			color="gray"
			aria-label={t`Show breakdown`}
			aria-expanded={open}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
		>
			{open ? <CaretDownIcon size={18} /> : <CaretRightIcon size={18} />}
		</ActionIcon>
	);
}

// Same affordance as the Usage and billing table: the dots open the account modal.
function ActionsButton({
	id,
	onOpenAccount,
}: {
	id: string;
	onOpenAccount?: (billingAccountId: string) => void;
}) {
	return (
		<ActionIcon
			variant="subtle"
			color="gray"
			onClick={(e) => {
				e.stopPropagation();
				onOpenAccount?.(id);
			}}
			aria-label={t`Open account actions`}
		>
			<DotsThreeIcon size={20} />
		</ActionIcon>
	);
}

function AccountName({ account: a }: { account: AiCostAccount }) {
	return (
		<Stack gap={0} style={{ minWidth: 0 }}>
			<Text
				size="xs"
				fw={500}
				truncate
				maw={260}
				title={a.name || a.billing_account_id}
			>
				{a.name || a.billing_account_id}
			</Text>
			<Text size="xs" c="dimmed" style={nowrap}>
				{accountContext(a)}
			</Text>
		</Stack>
	);
}

function BudgetText({ account: a }: { account: AiCostAccount }) {
	const { i18n } = useLingui();
	return (
		<Text
			size="xs"
			c={a.budget_micro_eur === null && !a.unlimited ? "dimmed" : undefined}
			style={nowrap}
		>
			{budgetLine(a, i18n.locale)}
		</Text>
	);
}

function TopGroup({ account: a }: { account: AiCostAccount }) {
	const top = groupFeatures(a.by_feature)[0];
	if (!top)
		return (
			<Text size="xs" c="dimmed">
				-
			</Text>
		);
	return (
		<Text size="xs" style={nowrap} data-testid="ai-cost-top-group">
			{top.label}{" "}
			<Text span size="xs" c="dimmed">
				{formatShare(top.share)}
			</Text>
		</Text>
	);
}

const budgetGap = { paddingLeft: 24 } as const;

function CostRow({ account: a, open, onToggle, onOpenAccount }: RowProps) {
	const id = a.billing_account_id;
	return (
		<Fragment>
			<Table.Tr
				data-testid={`ai-cost-row-${id}`}
				onClick={onToggle}
				style={{ cursor: "pointer" }}
			>
				<Table.Td>
					<ToggleButton open={open} onToggle={onToggle} />
				</Table.Td>
				<Table.Td>
					<AccountName account={a} />
				</Table.Td>
				<Table.Td style={{ textAlign: "right" }}>
					<Text size="xs" fw={500} style={nowrap}>
						{formatAiCost(a.cost_micro_eur)}
					</Text>
				</Table.Td>
				<Table.Td style={budgetGap}>
					<BudgetText account={a} />
				</Table.Td>
				<Table.Td>
					<UsedCell percent={a.percent_used} />
				</Table.Td>
				<Table.Td>
					<TopGroup account={a} />
				</Table.Td>
				<Table.Td>
					<ActionsButton id={id} onOpenAccount={onOpenAccount} />
				</Table.Td>
			</Table.Tr>
			{open && (
				<Table.Tr data-testid={`ai-cost-detail-${id}`}>
					<Table.Td colSpan={COLUMNS} bg="var(--mantine-color-default-hover)">
						<Breakdown account={a} />
					</Table.Td>
				</Table.Tr>
			)}
		</Fragment>
	);
}

const cardStyle = {
	boxShadow: `0 -1px 0 ${LINE}`,
	flex: "1 1 100%",
	minWidth: 0,
} as const;

// The phone layout: one card per account, same pieces as the table row.
function CostCard({ account: a, open, onToggle, onOpenAccount }: RowProps) {
	const id = a.billing_account_id;
	return (
		<Box style={cardStyle}>
			<Stack
				gap={6}
				p="xs"
				data-testid={`ai-cost-row-${id}`}
				onClick={onToggle}
				style={{ cursor: "pointer" }}
			>
				<Group gap="xs" wrap="nowrap" align="flex-start">
					<ToggleButton open={open} onToggle={onToggle} />
					<Box style={{ flex: 1, minWidth: 0 }}>
						<AccountName account={a} />
					</Box>
					<Text size="sm" fw={600} style={nowrap}>
						{formatAiCost(a.cost_micro_eur)}
					</Text>
					<ActionsButton id={id} onOpenAccount={onOpenAccount} />
				</Group>
				<Group justify="space-between" wrap="nowrap" gap="sm" pl={36}>
					<BudgetText account={a} />
					<UsedCell percent={a.percent_used} />
				</Group>
				<Group gap={6} wrap="nowrap" pl={36}>
					<Text size="xs" c="dimmed">
						<Trans>Top feature group</Trans>
					</Text>
					<TopGroup account={a} />
				</Group>
			</Stack>
			{open && (
				<Box
					data-testid={`ai-cost-detail-${id}`}
					bg="var(--mantine-color-default-hover)"
				>
					<Breakdown account={a} />
				</Box>
			)}
		</Box>
	);
}

/** Staff view of AI cost per billing account, every tier, in euros. */
export function AiCostsPanel({
	onOpenAccount,
}: {
	onOpenAccount?: (billingAccountId: string) => void;
}) {
	const { i18n } = useLingui();
	const [offset, setOffset] = useState<0 | 1>(0);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const { data, error, isLoading, refetch } = useAiCosts(offset);
	const narrow = useMediaQuery("(max-width: 48em)") ?? false;

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
	const rowProps = (a: AiCostAccount): RowProps => {
		const id = a.billing_account_id;
		const open = expanded[id] ?? false;
		return {
			account: a,
			onOpenAccount,
			onToggle: () => setExpanded((x) => ({ ...x, [id]: !open })),
			open,
		};
	};
	const charged =
		accounts.reduce((s, a) => s + a.cost_micro_eur, 0) +
		(data?.deleted_accounts_micro_eur ?? 0);
	const deleted = formatAiCost(data?.deleted_accounts_micro_eur ?? 0);
	// A provider with only unpriced calls gets no tile.
	const providers = (data?.by_provider ?? []).filter(
		(p) => p.cost_micro_eur > 0,
	);
	const overBudget = accounts.filter(
		(a) => a.percent_used !== null && a.percent_used >= 100,
	).length;
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
							their budget. Click a row for its breakdown.
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
					{total === 0 && accounts.length === 0 ? (
						<Text size="sm" c="dimmed">
							{offset === 0 ? (
								<Trans>No AI costs recorded this month.</Trans>
							) : (
								<Trans>No AI costs recorded for {month}.</Trans>
							)}
						</Text>
					) : (
						<Stack gap="md">
							<Stack gap="md" data-testid="ai-cost-summary">
								<Strip title={t`Spend`}>
									<Stat
										label={t`Total cost`}
										value={formatAiCost(total)}
										caption={t`Every priced AI call, all tiers`}
										testId="ai-cost-total"
									/>
									<Stat
										label={t`Charged to accounts`}
										value={formatAiCost(charged)}
										caption={
											data.deleted_accounts_micro_eur > 0
												? t`incl. ${deleted} from deleted accounts`
												: accounts.length === 0
													? t`No account was charged`
													: t`The account rows below`
										}
										testId="ai-cost-charged"
									/>
									<Stat
										label={t`Unattributed`}
										value={formatAiCost(data.unattributed_micro_eur)}
										caption={t`Calls no account could be matched to`}
										testId="ai-cost-unattributed"
									/>
									<Stat
										label={t`Internal`}
										value={formatAiCost(data.internal_micro_eur)}
										caption={t`Samples, demos and dev tools`}
										testId="ai-cost-internal"
									/>
								</Strip>
								<Strip title={t`Accounts and providers`}>
									<Stat
										label={t`Accounts with AI calls`}
										value={String(accounts.length)}
										caption={t`Billing accounts that made AI calls`}
										testId="ai-cost-accounts"
									/>
									<Stat
										label={t`Free accounts at or over budget`}
										value={String(overBudget)}
										caption={t`Free accounts at 100% or more`}
										testId="ai-cost-over-budget"
									/>
									{providers.map((p) => {
										const provider = p.provider;
										const share = formatShare(
											total > 0 ? p.cost_micro_eur / total : 0,
										);
										return (
											<Stat
												key={provider}
												label={t`Provider: ${provider}`}
												value={formatAiCost(p.cost_micro_eur)}
												caption={t`${share} of the total`}
												testId={`ai-cost-provider-${provider}`}
											/>
										);
									})}
								</Strip>
							</Stack>
							<Stack gap={4}>
								<Text size="xs" fw={600} tt="uppercase" c="dimmed">
									<Trans>By account</Trans>
								</Text>
								{accounts.length === 0 ? (
									<Text size="sm" c="dimmed">
										{offset === 0 ? (
											<Trans>No account was charged this month.</Trans>
										) : (
											<Trans>No account was charged in {month}.</Trans>
										)}
									</Text>
								) : narrow ? (
									// One strip like the tiles: cards split by single rules.
									<Box style={stripStyle}>
										{accounts.map((a) => (
											<CostCard key={a.billing_account_id} {...rowProps(a)} />
										))}
									</Box>
								) : (
									// Native scroll: no reserved scrollbar strip under the last row.
									<Table.ScrollContainer minWidth={820} type="native">
										<Table verticalSpacing="xs" fz="xs" highlightOnHover>
											<Table.Thead>
												<Table.Tr>
													<Table.Th style={{ width: 36 }} />
													<Table.Th>
														<Trans>Account</Trans>
													</Table.Th>
													<Table.Th style={{ textAlign: "right", width: 110 }}>
														<Trans>Cost</Trans>
													</Table.Th>
													<Table.Th style={{ ...budgetGap, width: 210 }}>
														<Trans>Budget</Trans>
													</Table.Th>
													<Table.Th style={{ width: 150 }}>
														<Trans>Used</Trans>
													</Table.Th>
													<Table.Th style={{ width: 190 }}>
														<Trans>Top feature group</Trans>
													</Table.Th>
													<Table.Th style={{ width: 36 }} />
												</Table.Tr>
											</Table.Thead>
											<Table.Tbody>
												{accounts.map((a) => (
													<CostRow
														key={a.billing_account_id}
														{...rowProps(a)}
													/>
												))}
											</Table.Tbody>
										</Table>
									</Table.ScrollContainer>
								)}
							</Stack>
						</Stack>
					)}
				</>
			)}
		</Stack>
	);
}
