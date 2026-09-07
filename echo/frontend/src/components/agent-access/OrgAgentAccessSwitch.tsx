import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Switch } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { type OrgAgentAccess, useSetOrgAgentAccessMutation } from "./hooks";

interface OrgAgentAccessSwitchProps {
	org: OrgAgentAccess;
	/** Show the label next to the switch. Off inside dense rows. */
	withLabel?: boolean;
}

// The organisation-level decision. Both directions confirm, because ON
// exposes every member's data to whatever they connect, and OFF cuts every
// running agent in the org mid-task.
export const OrgAgentAccessSwitch = ({
	org,
	withLabel = true,
}: OrgAgentAccessSwitchProps) => {
	const [enableOpened, enableHandlers] = useDisclosure(false);
	const [disableOpened, disableHandlers] = useDisclosure(false);
	const mutation = useSetOrgAgentAccessMutation();

	const onToggle = (next: boolean) => {
		if (next) enableHandlers.open();
		else disableHandlers.open();
	};

	const commit = (enabled: boolean) => {
		mutation.mutate(
			{ enabled, orgId: org.id },
			{
				onSettled: () => {
					enableHandlers.close();
					disableHandlers.close();
				},
			},
		);
	};

	return (
		<>
			<Switch
				checked={org.agent_access_enabled}
				onChange={(e) => onToggle(e.currentTarget.checked)}
				disabled={!org.can_manage || mutation.isPending}
				label={withLabel ? t`Allow MCP access` : undefined}
				aria-label={t`Allow MCP access in ${org.name}`}
				data-testid={`agent-access-switch-${org.id}`}
			/>
			<ConfirmModal
				opened={enableOpened}
				onClose={enableHandlers.close}
				onConfirm={() => commit(true)}
				loading={mutation.isPending}
				title={t`Turn on MCP access?`}
				confirmLabel={<Trans>Turn on</Trans>}
				data-testid="agent-access-enable-modal"
				message={
					<Trans>
						Members of {org.name} will be able to connect AI agents to what they
						can already see here. The agent and the company running it receive
						that content.
					</Trans>
				}
			/>
			<ConfirmModal
				opened={disableOpened}
				onClose={disableHandlers.close}
				onConfirm={() => commit(false)}
				loading={mutation.isPending}
				title={t`Turn off MCP access?`}
				confirmLabel={<Trans>Turn off</Trans>}
				confirmColor="red"
				data-testid="agent-access-disable-modal"
				message={
					<Trans>
						Every connected agent in {org.name} stops working immediately.
						Members keep their connections and they resume if you turn this back
						on.
					</Trans>
				}
			/>
		</>
	);
};
