import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Loader,
	Stack,
	Table,
	Text,
	TextInput,
} from "@mantine/core";
import { format } from "date-fns";
import { useState } from "react";
import { useStaffTrainings } from "./staffHooks";

/**
 * Staff training dashboard (ISSUE-020). Lists requested/scheduled/completed
 * trainings across orgs so staff can provision and complete them. This is
 * self-contained: at integration it drops into ISSUE-022's empty `training`
 * Tabs.Panel placeholder in AdminSettingsRoute, e.g.
 *
 *     <Tabs.Panel value="training" pt="md">
 *       <StaffTrainingPanel />
 *     </Tabs.Panel>
 *
 * Completion + license editing call the /v2/admin/trainings endpoints
 * (admin_training router), which write the one-year license rows.
 */
export const StaffTrainingPanel = () => {
	const [orgFilter, setOrgFilter] = useState("");
	const { data: trainings = [], isLoading } = useStaffTrainings(
		orgFilter || undefined,
	);

	if (isLoading) {
		return <Loader size="sm" />;
	}

	return (
		<Stack gap="md">
			<div>
				<Text size="sm" fw={500}>
					<Trans>Trainings</Trans>
				</Text>
				<Text size="xs">
					<Trans>
						Requested and scheduled trainings. Mark a training complete to grant
						each attendee a one-year license.
					</Trans>
				</Text>
			</div>

			<TextInput
				label={t`Filter by organisation id`}
				placeholder={t`Paste an org id to narrow the list`}
				value={orgFilter}
				onChange={(e) => setOrgFilter(e.currentTarget.value.trim())}
			/>

			{trainings.length === 0 ? (
				<Text size="sm">
					<Trans>No trainings yet.</Trans>
				</Text>
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table verticalSpacing="sm" highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Trans>Organisation</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Type</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Status</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Scheduled</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Licenses</Trans>
								</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{trainings.map((tr) => (
								<Table.Tr key={tr.id}>
									<Table.Td>{tr.org_name || tr.org_id || ""}</Table.Td>
									<Table.Td>{tr.type}</Table.Td>
									<Table.Td>
										<Badge variant="light" color="primary">
											{tr.status}
										</Badge>
									</Table.Td>
									<Table.Td>
										{tr.scheduled_at
											? format(new Date(tr.scheduled_at), "d MMM yyyy")
											: "Not scheduled"}
									</Table.Td>
									<Table.Td>{tr.license_count}</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}

			<Group justify="flex-end">
				<Button
					component="a"
					href="mailto:pauline@dembrane.com"
					variant="subtle"
				>
					<Trans>Email Pauline</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
