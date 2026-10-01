import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Group,
	Loader,
	SegmentedControl,
	Stack,
	Table,
	Text,
	TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { call } from "../api/client";
import { useAccountList } from "../api/hooks";
import { formatDate, stageLabel } from "../format";
import { AccountsI18n } from "../i18n";

/**
 * Staff: every customer account in one bounded table, with what is open on each side.
 * Counts only; the card behind a row holds the detail and the actions.
 */
export const AccountsPanel = () => (
	<AccountsI18n>
		<AccountsTable />
	</AccountsI18n>
);

const Count = ({ n, tone }: { n: number; tone?: "red" | "blue" }) =>
	n === 0 ? (
		<Text size="sm" c="dimmed">
			0
		</Text>
	) : (
		<Badge variant="light" color={tone ?? "gray"} size="sm">
			{n}
		</Badge>
	);

function AccountsTable() {
	const { i18n } = useLingui();
	const [stage, setStage] = useState<string>("all");
	const [search, setSearch] = useState("");
	const [q] = useDebouncedValue(search.trim(), 250);
	const { data, isLoading, error } = useAccountList(
		stage === "all" ? null : stage,
		q,
	);
	const navigate = useI18nNavigate();

	return (
		<Stack gap="sm" data-testid="accounts-panel">
			<Group justify="space-between" gap="sm">
				<Group gap="sm" style={{ flex: 1, minWidth: 260 }}>
					<TextInput
						aria-label={t`Search organisations`}
						placeholder={t`Search by name or member email`}
						leftSection={<MagnifyingGlassIcon size={14} />}
						value={search}
						onChange={(e) => setSearch(e.currentTarget.value)}
						style={{ flex: 1, maxWidth: 340 }}
						data-testid="accounts-search"
					/>
					<SegmentedControl
						size="xs"
						value={stage}
						onChange={setStage}
						data={[
							{ label: t`All`, value: "all" },
							{ label: t`Prospects`, value: "prospect" },
							{ label: t`Customers`, value: "customer" },
							{ label: t`Churned`, value: "churned" },
							{ label: t`No account`, value: "none" },
						]}
					/>
				</Group>
				<Button
					size="xs"
					onClick={() => navigate("/admin/accounts/new-demo")}
					data-testid="new-demo"
				>
					<Trans>New demo</Trans>
				</Button>
			</Group>
			<OpenDemos />
			{isLoading && <Loader size="sm" />}
			{error && (
				<Alert color="red">
					<Trans>Accounts could not be loaded.</Trans>
				</Alert>
			)}
			{data && data.accounts.length === 0 && (
				<Text size="sm" c="dimmed">
					<Trans>No organisations match.</Trans>
				</Text>
			)}
			{data && data.accounts.length > 0 && (
				<Table.ScrollContainer minWidth={760}>
					<Table highlightOnHover verticalSpacing="xs">
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Trans>Organisation</Trans>
								</Table.Th>
								<Table.Th w={110}>
									<Trans>Stage</Trans>
								</Table.Th>
								<Table.Th w={100} ta="center">
									<Trans>Open tasks</Trans>
								</Table.Th>
								<Table.Th w={110} ta="center">
									<Trans>Waiting on us</Trans>
								</Table.Th>
								<Table.Th w={100} ta="center">
									<Trans>Unsigned</Trans>
								</Table.Th>
								<Table.Th w={100} ta="center">
									<Trans>Overdue</Trans>
								</Table.Th>
								<Table.Th w={100} ta="center">
									<Trans>Questions</Trans>
								</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{data.accounts.map((a) => (
								<Table.Tr
									key={a.id}
									style={{ cursor: "pointer" }}
									onClick={() => navigate(`/admin/accounts/${a.id}`)}
									data-testid="account-row"
								>
									<Table.Td>
										<Anchor
											component={I18nLink}
											to={`/admin/accounts/${a.id}`}
											size="sm"
											onClick={(e) => e.stopPropagation()}
										>
											{a.name}
										</Anchor>
										<Text size="xs" c="dimmed">
											<Trans>
												Since {formatDate(a.created_at, i18n.locale)}
											</Trans>
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm">{stageLabel(a.stage)}</Text>
									</Table.Td>
									<Table.Td ta="center">
										<Count n={a.open_tasks} />
									</Table.Td>
									<Table.Td ta="center">
										<Count n={a.waiting_on_us} tone="blue" />
									</Table.Td>
									<Table.Td ta="center">
										<Count n={a.unsigned_documents} />
									</Table.Td>
									<Table.Td ta="center">
										<Count n={a.overdue_invoices} tone="red" />
									</Table.Td>
									<Table.Td ta="center">
										<Count n={a.open_tickets} />
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
		</Stack>
	);
}

/** Demos still building, failed or waiting to be published: the ones that need staff. */
function OpenDemos() {
	const { data } = useQuery({
		queryFn: () => call("listDemos"),
		queryKey: ["accounts", "demos"],
		refetchInterval: 5000,
	});
	const open = (data?.demos ?? [])
		.filter((d) => d.status !== "published")
		.slice(0, 5);
	if (open.length === 0) return null;
	return (
		<Group gap="xs" data-testid="open-demos">
			<Text size="xs" c="dimmed">
				<Trans>Demos</Trans>
			</Text>
			{open.map((d) => (
				<Anchor
					key={d.id}
					component={I18nLink}
					to={`/admin/accounts/demos/${d.id}`}
					size="xs"
				>
					<Badge
						variant="light"
						size="sm"
						color={
							d.status === "failed"
								? "red"
								: d.status === "draft"
									? "blue"
									: "gray"
						}
						style={{ cursor: "pointer", textTransform: "none" }}
					>
						{d.organisation_name} ·{" "}
						{d.status === "failed"
							? t`failed`
							: d.status === "draft"
								? t`ready to publish`
								: t`building`}
					</Badge>
				</Anchor>
			))}
		</Group>
	);
}
