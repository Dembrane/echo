import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Button,
	Group,
	Loader,
	Table,
	Text,
} from "@mantine/core";
import type React from "react";
import { I18nLink } from "@/components/common/i18nLink";
import {
	type OrgAgentAccess,
	useAgentOrganisationsQuery,
	useSetOrgAgentAccessMutation,
} from "./hooks";

// Name and state cells shared by the Connect page and the organisation
// settings page, so a change to either column lands in both. The action
// column belongs to the caller: what a row can do depends on who is looking.
export const OrgAccessRow = ({
	org,
	action,
}: {
	org: OrgAgentAccess;
	action: React.ReactNode;
}) => {
	const on = org.agent_access_enabled;
	return (
		<Table.Tr data-testid={`agent-org-${org.id}`}>
			<Table.Td>
				<Text size="sm" fw={500} truncate>
					{org.name}
				</Text>
			</Table.Td>
			<Table.Td>
				<Badge
					size="sm"
					variant="light"
					color={on ? "green" : "gray"}
					data-testid={`agent-org-status-${org.id}`}
				>
					{on ? <Trans>On</Trans> : <Trans>Off</Trans>}
				</Badge>
			</Table.Td>
			<Table.Td>{action}</Table.Td>
		</Table.Tr>
	);
};

// A three-column table, not a stretched row: name, state and the one action
// sit next to each other, so with many organisations the eye never has to
// cross the page to match a control to its row.
export const OrgAccessTable = ({
	children,
	...props
}: React.ComponentProps<typeof Table>) => (
	<Table verticalSpacing="xs" maw={560} {...props}>
		<Table.Thead>
			<Table.Tr>
				<Table.Th>
					<Trans>Organisation</Trans>
				</Table.Th>
				<Table.Th w={110}>
					<Trans>MCP access</Trans>
				</Table.Th>
				<Table.Th w={160} />
			</Table.Tr>
		</Table.Thead>
		<Table.Tbody>{children}</Table.Tbody>
	</Table>
);

// Admins flip an Off org from here with no confirm: the first-visit notice
// already carried the risk.
const OrgRow = ({ org }: { org: OrgAgentAccess }) => {
	const setOrgAccess = useSetOrgAgentAccessMutation();
	const on = org.agent_access_enabled;

	return (
		<OrgAccessRow
			org={org}
			action={
				on ? (
					org.can_manage && (
						<Anchor
							component={I18nLink}
							to={`/o/${org.id}/settings/agents`}
							size="sm"
							data-testid={`agent-org-manage-${org.id}`}
						>
							<Trans>Manage</Trans>
						</Anchor>
					)
				) : org.can_manage ? (
					<Button
						size="xs"
						variant="light"
						loading={
							setOrgAccess.isPending && setOrgAccess.variables?.orgId === org.id
						}
						disabled={setOrgAccess.isPending}
						onClick={() =>
							setOrgAccess.mutate({ enabled: true, orgId: org.id })
						}
						data-testid={`agent-org-enable-${org.id}`}
					>
						<Trans>Turn on</Trans>
					</Button>
				) : (
					<Text size="sm" c="dimmed" data-testid={`agent-org-ask-${org.id}`}>
						<Trans>Ask your admin</Trans>
					</Text>
				)
			}
		/>
	);
};

export const YourOrganisations = () => {
	const { data: orgs, isLoading } = useAgentOrganisationsQuery();

	if (isLoading) {
		return (
			<Group justify="center" py="md">
				<Loader size="sm" color="gray" />
			</Group>
		);
	}

	if (!orgs || orgs.length === 0) {
		return (
			<Text size="sm" c="dimmed" data-testid="agent-org-empty">
				<Trans>You are not in an organisation yet.</Trans>
			</Text>
		);
	}

	return (
		<OrgAccessTable data-testid="agent-your-organisations">
			{orgs.map((org) => (
				<OrgRow key={org.id} org={org} />
			))}
		</OrgAccessTable>
	);
};
