import { Trans } from "@lingui/react/macro";
import { Alert, List, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

interface AgentRiskNoticeProps {
	freeTierMonthlyCalls?: number;
	/** Names the agent when known (consent page), else speaks generally. */
	clientName?: string;
}

// The one place the risk is spelled out. Settings, consent and the org page
// all render this so the wording never drifts between surfaces.
export const AgentRiskNotice = ({
	freeTierMonthlyCalls,
	clientName,
}: AgentRiskNoticeProps) => (
	<Alert
		color="orange"
		variant="light"
		icon={<IconAlertTriangle size={18} />}
		title={<Trans>Before you connect an agent</Trans>}
		data-testid="agent-risk-notice"
	>
		<List size="sm" spacing={4}>
			<List.Item>
				{clientName ? (
					<Trans>
						{clientName} and the company running it will receive the
						conversation content you allow.
					</Trans>
				) : (
					<Trans>
						The agent and the company running it will receive the conversation
						content you allow.
					</Trans>
				)}
			</List.Item>
			<List.Item>
				<Trans>
					dembrane is not responsible for what a third party does with that
					content.
				</Trans>
			</List.Item>
			<List.Item>
				<Trans>You can revoke a connection at any time.</Trans>
			</List.Item>
			{freeTierMonthlyCalls != null && (
				<List.Item>
					<Trans>
						Free organisations have a monthly limit of {freeTierMonthlyCalls}{" "}
						calls.
					</Trans>
				</List.Item>
			)}
		</List>
		<Text size="xs" c="dimmed" mt="xs">
			<Trans>
				The agent acts as you: it can only see what you can already see.
			</Trans>
		</Text>
	</Alert>
);
