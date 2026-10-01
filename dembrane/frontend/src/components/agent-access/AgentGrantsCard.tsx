import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Card,
	Group,
	Loader,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import {
	formatDate,
	formatDateTime,
	grantStatusColor,
	grantStatusLabel,
} from "./format";
import { type AgentGrant, useRevokeAgentGrantMutation } from "./hooks";

interface AgentGrantsCardProps {
	grants: AgentGrant[] | undefined;
	isLoading: boolean;
	/** Set on the org page: revokes go through the admin endpoint. */
	orgId?: string;
	/** Org page lists every member's grants, so name the member. */
	showUser?: boolean;
	/** Hide the Organisations column: on an org-filtered page it repeats the page. */
	hideOrgs?: boolean;
	/** The page supplies its own heading and spacing: no card, no title. */
	bare?: boolean;
}

export const AgentGrantsCard = ({
	grants,
	isLoading,
	orgId,
	showUser = false,
	hideOrgs = false,
	bare = false,
}: AgentGrantsCardProps) => {
	const [target, setTarget] = useState<AgentGrant | null>(null);
	const [opened, handlers] = useDisclosure(false);
	const revoke = useRevokeAgentGrantMutation();

	const askRevoke = (grant: AgentGrant) => {
		setTarget(grant);
		handlers.open();
	};

	const confirmRevoke = () => {
		if (!target) return;
		revoke.mutate(
			{ grantId: target.id, orgId },
			{ onSettled: () => handlers.close() },
		);
	};

	const rows = grants ?? [];

	const body = (
		<Stack gap="md">
			{!bare && (
				<Text size="sm" fw={500}>
					<Trans>Connected agents</Trans>
				</Text>
			)}
			{isLoading ? (
				<Group justify="center" py="md">
					<Loader size="sm" color="gray" />
				</Group>
			) : rows.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>No agents connected yet.</Trans>
				</Text>
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table verticalSpacing="xs" data-testid="agent-grants-table">
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Trans>Agent</Trans>
								</Table.Th>
								{showUser && (
									<Table.Th>
										<Trans>Member</Trans>
									</Table.Th>
								)}
								{!hideOrgs && (
									<Table.Th>
										<Trans>Organisations</Trans>
									</Table.Th>
								)}
								<Table.Th>
									<Trans>Expires</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Last used</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Status</Trans>
								</Table.Th>
								<Table.Th />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{rows.map((grant) => {
								const active = grant.status === "active";
								return (
									<Table.Tr
										key={grant.id}
										style={active ? undefined : { opacity: 0.55 }}
										data-testid={`agent-grant-${grant.id}`}
									>
										<Table.Td>
											<Text size="sm" fw={500}>
												{grant.client_name}
											</Text>
										</Table.Td>
										{showUser && (
											<Table.Td>
												<Text size="sm">
													{grant.user_display_name ||
														grant.user_email ||
														t`Unknown member`}
												</Text>
											</Table.Td>
										)}
										{!hideOrgs && (
											<Table.Td>
												<Text size="sm">{grant.org_names.join(", ")}</Text>
											</Table.Td>
										)}
										<Table.Td>
											<Text size="sm">
												{grant.expires_at
													? formatDate(grant.expires_at)
													: t`Never`}
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm">
												{grant.last_used_at
													? formatDateTime(grant.last_used_at)
													: t`Never`}
											</Text>
										</Table.Td>
										<Table.Td>
											<Badge
												size="sm"
												variant="light"
												color={grantStatusColor(grant.status)}
											>
												{grantStatusLabel(grant.status)}
											</Badge>
										</Table.Td>
										<Table.Td>
											{active && (
												<Button
													size="xs"
													variant="outline"
													color="red"
													onClick={() => askRevoke(grant)}
													data-testid={`agent-grant-revoke-${grant.id}`}
												>
													<Trans>Revoke</Trans>
												</Button>
											)}
										</Table.Td>
									</Table.Tr>
								);
							})}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
		</Stack>
	);

	return (
		<>
			{bare ? (
				body
			) : (
				<Card withBorder p="lg" radius="md">
					{body}
				</Card>
			)}
			<ConfirmModal
				opened={opened}
				onClose={handlers.close}
				onConfirm={confirmRevoke}
				loading={revoke.isPending}
				title={t`Revoke this connection?`}
				confirmLabel={<Trans>Revoke</Trans>}
				confirmColor="red"
				data-testid="agent-grant-revoke-modal"
				message={
					target ? (
						<Trans>
							{target.client_name} loses access immediately. To connect it
							again, start over from the agent.
						</Trans>
					) : null
				}
			/>
		</>
	);
};
