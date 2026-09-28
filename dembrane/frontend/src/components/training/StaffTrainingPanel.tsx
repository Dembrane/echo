import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	Loader,
	SegmentedControl,
	Stack,
	Table,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { TrainingRowActions } from "./TrainingRowActions";
import { type StaffTrainingRow, useStaffTrainings } from "./staffHooks";

/** Staff training dashboard: lists trainings across orgs with request detail
 *  and provisions them. Reached from the admin sidebar at /admin/training. */
const participantsLabel = (tr: StaffTrainingRow): string =>
	tr.extra_participants > 0
		? `${tr.included_participants} + ${tr.extra_participants}`
		: `${tr.included_participants}`;

const estimatedCost = (tr: StaffTrainingRow): number =>
	(tr.base_price_eur ?? 0) + (tr.extra_price_eur ?? 0) * tr.extra_participants;

// Light badges use graphite text, not the accent colour (founder decision).
const graphiteLabel = { label: { color: "var(--app-text)" } };

// "partially completed" = completed but active licenses cover only some org
// members (denominator is member count, not seat capacity).
const statusBadge = (
	tr: StaffTrainingRow,
): { label: string; color: string; variant: string } => {
	// A completed license-granting training with no active licenses (all revoked)
	// isn't really completed; show its lifecycle status instead.
	const effective =
		tr.status === "completed" && tr.grants_license && tr.license_count === 0
			? tr.scheduled_at
				? "scheduled"
				: "requested"
			: tr.status;

	if (
		effective === "completed" &&
		tr.license_count > 0 &&
		tr.org_member_count > 0 &&
		tr.license_count < tr.org_member_count
	) {
		return { label: t`partially completed`, color: "peach", variant: "light" };
	}
	switch (effective) {
		case "requested":
			return { label: effective, color: "primary", variant: "filled" };
		case "scheduled":
			return { label: effective, color: "primary", variant: "light" };
		case "completed":
			return { label: effective, color: "springGreen", variant: "light" };
		case "cancelled":
			return { label: effective, color: "red", variant: "light" };
		default:
			return { label: effective, color: "primary", variant: "outline" };
	}
};

export const StaffTrainingPanel = () => {
	const [orgQuery, setOrgQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState("");
	// Fetch all once and filter in memory (low-volume); search matches org
	// name/id by substring.
	const { data: trainings = [], isLoading } = useStaffTrainings();

	const filtered = useMemo(() => {
		const q = orgQuery.trim().toLowerCase();
		return trainings.filter((tr) => {
			const matchesStatus = !statusFilter || tr.status === statusFilter;
			const matchesOrg =
				!q ||
				(tr.org_name ?? "").toLowerCase().includes(q) ||
				(tr.org_id ?? "").toLowerCase().includes(q);
			return matchesStatus && matchesOrg;
		});
	}, [trainings, orgQuery, statusFilter]);

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

			<Group align="flex-end" gap="md">
				<TextInput
					label={t`Search by organisation`}
					placeholder={t`Filter by name or id`}
					value={orgQuery}
					onChange={(e) => setOrgQuery(e.currentTarget.value)}
					style={{ flex: 1 }}
				/>
				<SegmentedControl
					value={statusFilter || "all"}
					onChange={(v) => setStatusFilter(v === "all" ? "" : v)}
					data={[
						{ label: t`All`, value: "all" },
						{ label: t`Requested`, value: "requested" },
						{ label: t`Scheduled`, value: "scheduled" },
						{ label: t`Completed`, value: "completed" },
					]}
				/>
			</Group>

			{filtered.length === 0 ? (
				<Text size="sm">
					{trainings.length === 0 ? (
						<Trans>No trainings yet.</Trans>
					) : (
						<Trans>No trainings match your filters.</Trans>
					)}
				</Text>
			) : (
				<Table.ScrollContainer minWidth={980}>
					<Table verticalSpacing="sm" highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Trans>Organisation</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Requester</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Requested</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Type</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Participants</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Estimated cost</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Notes</Trans>
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
								<Table.Th aria-label={t`Manage`} />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{filtered.map((tr) => (
								<Table.Tr key={tr.id}>
									<Table.Td>{tr.org_name || tr.org_id || ""}</Table.Td>
									<Table.Td>
										{tr.requested_by_name ? (
											<Tooltip
												label={tr.requested_by_email ?? ""}
												disabled={!tr.requested_by_email}
											>
												<Text size="sm">{tr.requested_by_name}</Text>
											</Tooltip>
										) : (
											<Text size="sm">
												<Trans>Staff-created</Trans>
											</Text>
										)}
									</Table.Td>
									<Table.Td>
										{tr.created_at
											? format(new Date(tr.created_at), "d MMM yyyy")
											: ""}
									</Table.Td>
									<Table.Td>{tr.type}</Table.Td>
									<Table.Td>{participantsLabel(tr)}</Table.Td>
									<Table.Td>€{estimatedCost(tr).toFixed(2)}</Table.Td>
									<Table.Td maw={200}>
										{tr.notes ? (
											<Tooltip label={tr.notes} multiline maw={360} withArrow>
												<Text size="sm" lineClamp={1}>
													{tr.notes}
												</Text>
											</Tooltip>
										) : (
											""
										)}
									</Table.Td>
									<Table.Td>
										{(() => {
											const b = statusBadge(tr);
											return (
												<Badge
													color={b.color}
													variant={b.variant}
													styles={
														b.variant === "light" ? graphiteLabel : undefined
													}
												>
													{b.label}
												</Badge>
											);
										})()}
									</Table.Td>
									<Table.Td>
										{tr.scheduled_at
											? format(new Date(tr.scheduled_at), "d MMM yyyy")
											: t`Not scheduled`}
									</Table.Td>
									<Table.Td>{tr.license_count}</Table.Td>
									<Table.Td>
										<TrainingRowActions training={tr} />
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
		</Stack>
	);
};
