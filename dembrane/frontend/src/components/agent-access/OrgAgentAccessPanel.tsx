import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Code,
	Group,
	Loader,
	Stack,
	Table,
	Text,
	Title,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { I18nLink } from "@/components/common/i18nLink";
import { SectionHeading } from "./AgentAccessSection";
import { AgentGrantsCard } from "./AgentGrantsCard";
import { auditStatusColor, formatDateTime } from "./format";
import {
	type AgentAuditEvent,
	type OrgAgentAccess,
	useAgentOrganisationsQuery,
	useOrgAgentAuditQuery,
	useOrgAgentGrantsQuery,
} from "./hooks";
import { OrgAgentAccessSwitch } from "./OrgAgentAccessSwitch";
import { OrgAccessRow, OrgAccessTable } from "./YourOrganisations";

const OrgCallsLine = ({ org }: { org: OrgAgentAccess }) => {
	if (org.is_paid || org.monthly_limit == null) {
		return (
			<Text size="xs" c="dimmed">
				<Trans>{org.calls_this_month} calls this month</Trans>
			</Text>
		);
	}
	return (
		<Text size="xs" c="dimmed">
			<Trans>
				{org.calls_this_month} of {org.monthly_limit} calls this month (free
				plan)
			</Trans>
		</Text>
	);
};

const ActivityTable = ({
	events,
	isLoading,
}: {
	events: AgentAuditEvent[] | undefined;
	isLoading: boolean;
}) => {
	const rows = events ?? [];
	if (isLoading) {
		return (
			<Group justify="center" py="md">
				<Loader size="sm" color="gray" />
			</Group>
		);
	}
	if (rows.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				<Trans>No agent calls yet.</Trans>
			</Text>
		);
	}
	return (
		<Table.ScrollContainer minWidth={640}>
			<Table verticalSpacing="xs" data-testid="agent-audit-table">
				<Table.Thead>
					<Table.Tr>
						<Table.Th>
							<Trans>Member</Trans>
						</Table.Th>
						<Table.Th>
							<Trans>Agent</Trans>
						</Table.Th>
						<Table.Th>
							<Trans>Tool</Trans>
						</Table.Th>
						<Table.Th>
							<Trans>Status</Trans>
						</Table.Th>
						<Table.Th>
							<Trans>When</Trans>
						</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{rows.map((event) => (
						<Table.Tr key={event.id} data-testid={`agent-audit-${event.id}`}>
							<Table.Td>
								<Text size="sm">
									{event.user_display_name ||
										event.user_email ||
										t`Unknown member`}
								</Text>
							</Table.Td>
							<Table.Td>
								<Text size="sm">{event.client_name || event.client_id}</Text>
							</Table.Td>
							<Table.Td>
								<Code>{event.tool}</Code>
							</Table.Td>
							<Table.Td>
								<Badge
									size="sm"
									variant="light"
									color={auditStatusColor(event.status)}
								>
									{event.status}
								</Badge>
							</Table.Td>
							<Table.Td>
								<Text size="sm">{formatDateTime(event.created_at)}</Text>
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
		</Table.ScrollContainer>
	);
};

interface OrgAgentAccessPanelProps {
	orgId: string;
	orgName: string;
}

// Organisation settings > MCP access. Admin-only; the route gates it. Reads
// like the Connect page filtered to one organisation: the same row, the same
// grants table, plus the audit trail only an admin gets. The MCP URL stays on
// the Connect page so there is one place to copy it from.
export const OrgAgentAccessPanel = ({
	orgId,
	orgName,
}: OrgAgentAccessPanelProps) => {
	const { data: organisations, isLoading: orgsLoading } =
		useAgentOrganisationsQuery();
	const { data: grants, isLoading: grantsLoading } =
		useOrgAgentGrantsQuery(orgId);
	const { data: audit, isLoading: auditLoading } = useOrgAgentAuditQuery(orgId);

	const org = organisations?.find((o) => o.id === orgId);

	return (
		<Stack gap="xl">
			<Stack gap="sm">
				<Stack gap={4}>
					<Title order={3}>
						<Trans>MCP access</Trans>
					</Title>
				</Stack>
				<Alert
					variant="light"
					icon={<IconInfoCircle />}
					data-testid="agent-org-scope-callout"
				>
					<Trans>
						This page is about {orgName} only. To get your MCP URL, or to manage
						other organisations, go to{" "}
						<Anchor
							component={I18nLink}
							to="/connect-agent"
							size="sm"
							data-testid="agent-org-connect-link"
						>
							Connect your agent
						</Anchor>
						.
					</Trans>
				</Alert>
			</Stack>

			<Stack gap="sm">
				<SectionHeading>
					<Trans>This organisation</Trans>
				</SectionHeading>
				{orgsLoading ? (
					<Group justify="center" py="md">
						<Loader size="sm" color="gray" />
					</Group>
				) : org ? (
					<>
						<OrgAccessTable data-testid="agent-this-organisation">
							<OrgAccessRow
								org={org}
								action={<OrgAgentAccessSwitch org={org} withLabel={false} />}
							/>
						</OrgAccessTable>
						<OrgCallsLine org={org} />
					</>
				) : (
					<Text size="sm" c="dimmed">
						<Trans>You cannot manage MCP access for this organisation.</Trans>
					</Text>
				)}
			</Stack>

			<Stack gap="sm">
				<SectionHeading>
					<Trans>Connected agents</Trans>
				</SectionHeading>
				<Text size="sm" c="dimmed">
					<Trans>Every member's connection that names this organisation.</Trans>
				</Text>
				<AgentGrantsCard
					grants={grants}
					isLoading={grantsLoading}
					orgId={orgId}
					hideOrgs
					showUser
					bare
				/>
			</Stack>

			<Stack gap="sm">
				<SectionHeading>
					<Trans>Activity</Trans>
				</SectionHeading>
				<Text size="sm" c="dimmed">
					<Trans>
						Every call an agent made in this organisation, newest first.
					</Trans>
				</Text>
				<ActivityTable events={audit} isLoading={auditLoading} />
			</Stack>
		</Stack>
	);
};
