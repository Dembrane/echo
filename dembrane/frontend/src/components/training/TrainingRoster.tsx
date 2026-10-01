import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, Stack, Table, Text } from "@mantine/core";
import { format } from "date-fns";
import type { RosterEntry } from "./hooks";

interface TrainingRosterProps {
	members: RosterEntry[];
	showEmails: boolean;
}

function formatUntil(iso: string | null): string {
	if (!iso) return "";
	try {
		return format(new Date(iso), "d MMM yyyy");
	} catch {
		return "";
	}
}

/**
 * Members-style roster with a training-status column. The training_license
 * row is the verification record, so each member reads as trained (with a
 * trained-until date) or not trained. Both the org admin and staff see this.
 */
export const TrainingRoster = ({
	members,
	showEmails,
}: TrainingRosterProps) => {
	if (members.length === 0) {
		return (
			<Text size="sm">
				<Trans>No members yet.</Trans>
			</Text>
		);
	}

	return (
		<Table.ScrollContainer minWidth={420}>
			<Table verticalSpacing="sm" highlightOnHover>
				<Table.Thead>
					<Table.Tr>
						<Table.Th>
							<Trans>Member</Trans>
						</Table.Th>
						<Table.Th>
							<Trans>Training</Trans>
						</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{members.map((m) => (
						<Table.Tr key={m.app_user_id}>
							<Table.Td>
								<Stack gap={0}>
									<Text size="sm">{m.display_name || t`Member`}</Text>
									{showEmails && m.email && <Text size="xs">{m.email}</Text>}
								</Stack>
							</Table.Td>
							<Table.Td>
								<TrainingStatusCell entry={m} />
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
		</Table.ScrollContainer>
	);
};

// Light badges use graphite text, not the accent colour (founder decision).
const graphiteLabel = { label: { color: "var(--app-text)" } };

const TrainingStatusCell = ({ entry }: { entry: RosterEntry }) => {
	if (!entry.trained) {
		return (
			<Badge variant="light" color="parchment" styles={graphiteLabel}>
				<Trans>Not trained</Trans>
			</Badge>
		);
	}
	const until = formatUntil(entry.trained_until);
	return (
		<Group gap="xs">
			<Badge variant="light" color="springGreen" styles={graphiteLabel}>
				{until ? <Trans>Trained until {until}</Trans> : <Trans>Trained</Trans>}
			</Badge>
			{entry.expiring_soon && (
				<Badge variant="light" color="peach" styles={graphiteLabel}>
					<Trans>Expiring soon</Trans>
				</Badge>
			)}
		</Group>
	);
};
