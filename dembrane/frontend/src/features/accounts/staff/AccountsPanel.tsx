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
	Select,
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
import { dealStageLabel, formatDate } from "../format";
import { AccountsI18n } from "../i18n";
import { NewOrganisationModal } from "./NewOrganisationModal";

/**
 * Staff: every account in one bounded table under the deal stages the team uses in Attio,
 * each step with the day it happened. The card behind a row holds the detail and the actions.
 */
export const AccountsPanel = () => (
	<AccountsI18n>
		<AccountsTable />
	</AccountsI18n>
);

const STAGES = [
	"in_progress",
	"offer_drafted",
	"offer_sent",
	"offer_accepted",
	"invoice_sent",
	"paid",
	"lost",
	"parked",
] as const;

/** A step's day, or a dot while the deal has not reached it. */
const Step = ({ at }: { at: string | null }) => {
	const { i18n } = useLingui();
	return at ? (
		<Text size="sm">
			{new Intl.DateTimeFormat(i18n.locale, {
				day: "numeric",
				month: "short",
			}).format(new Date(at))}
		</Text>
	) : (
		<Text size="sm" c="dimmed">
			·
		</Text>
	);
};

function AccountsTable() {
	const { i18n } = useLingui();
	const [stage, setStage] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [q] = useDebouncedValue(search.trim(), 250);
	const { data, isLoading, error } = useAccountList(stage, q);
	const navigate = useI18nNavigate();
	const [newOrgOpen, setNewOrgOpen] = useState(false);

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
					<Select
						aria-label={t`Stage`}
						placeholder={t`All stages`}
						value={stage}
						onChange={setStage}
						data={STAGES.map((s) => ({ label: dealStageLabel(s), value: s }))}
						clearable
						w={220}
						data-testid="accounts-stage"
					/>
				</Group>
				<Group gap="xs">
					<Button
						size="xs"
						variant="default"
						onClick={() => setNewOrgOpen(true)}
						data-testid="new-organisation"
					>
						<Trans>New organisation</Trans>
					</Button>
					<Button
						size="xs"
						onClick={() => navigate("/admin/accounts/new-demo")}
						data-testid="new-demo"
					>
						<Trans>New demo</Trans>
					</Button>
				</Group>
			</Group>
			<NewOrganisationModal
				opened={newOrgOpen}
				onClose={() => setNewOrgOpen(false)}
				onCreated={(orgId) => navigate(`/admin/accounts/${orgId}`)}
			/>
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
				<Table.ScrollContainer minWidth={900}>
					<Table highlightOnHover verticalSpacing="xs">
						<Table.Thead>
							<Table.Tr>
								<Table.Th rowSpan={2}>
									<Trans>Organisation</Trans>
								</Table.Th>
								<Table.Th rowSpan={2} w={170}>
									<Trans>Stage</Trans>
								</Table.Th>
								<Table.Th rowSpan={2} w={100}>
									{dealStageLabel("offer_drafted")}
								</Table.Th>
								<Table.Th rowSpan={2} w={100}>
									{dealStageLabel("offer_sent")}
								</Table.Th>
								<Table.Th colSpan={3} ta="center">
									{dealStageLabel("offer_accepted")}
								</Table.Th>
								<Table.Th rowSpan={2} w={100}>
									{dealStageLabel("invoice_sent")}
								</Table.Th>
							</Table.Tr>
							<Table.Tr>
								<Table.Th w={90}>
									<Trans>Signed</Trans>
								</Table.Th>
								<Table.Th w={110}>
									<Trans>Billing details</Trans>
								</Table.Th>
								<Table.Th w={100}>
									<Trans>Documents</Trans>
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
									<Table.Td data-testid="account-deal-stage">
										<Text size="sm">
											{a.deal_stage ? dealStageLabel(a.deal_stage) : "·"}
										</Text>
									</Table.Td>
									<Table.Td>
										<Step at={a.milestones.offer_drafted} />
									</Table.Td>
									<Table.Td>
										<Step at={a.milestones.offer_sent} />
									</Table.Td>
									<Table.Td>
										<Step at={a.milestones.signed} />
									</Table.Td>
									<Table.Td>
										<Step at={a.milestones.billing_details} />
									</Table.Td>
									<Table.Td>
										<Step at={a.milestones.documents_signed} />
									</Table.Td>
									<Table.Td>
										<Step at={a.milestones.invoice_sent} />
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
