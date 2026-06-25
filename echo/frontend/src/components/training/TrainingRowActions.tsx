import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Checkbox,
	Group,
	Loader,
	Menu,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import { DotsThreeVertical } from "@phosphor-icons/react";
import { format } from "date-fns";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import {
	type StaffTrainingRow,
	type TrainingLicense,
	useCompleteTraining,
	useRevokeLicense,
	useStaffOrgRoster,
	useTrainingLicenses,
	useUpdateTraining,
} from "./staffHooks";

/** Per-row provisioning: schedule, complete (additive — already-trained members
 *  can't be re-granted), cancel, reopen. Revoking the last license un-completes. */
export const TrainingRowActions = ({
	training,
}: {
	training: StaffTrainingRow;
}) => {
	const [scheduleOpen, scheduleHandlers] = useDisclosure(false);
	const [completeOpen, completeHandlers] = useDisclosure(false);
	const [cancelOpen, cancelHandlers] = useDisclosure(false);

	const updateMutation = useUpdateTraining();
	const completeMutation = useCompleteTraining();
	const revokeMutation = useRevokeLicense();

	const [scheduleDate, setScheduleDate] = useState<Date | null>(
		training.scheduled_at ? new Date(training.scheduled_at) : null,
	);

	// Roster + this training's licenses load lazily when the modal opens.
	const roster = useStaffOrgRoster(training.org_id, completeOpen);
	const licenses = useTrainingLicenses(training.id, completeOpen);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [completedDate, setCompletedDate] = useState<Date | null>(new Date());
	const [revokeTarget, setRevokeTarget] = useState<TrainingLicense | null>(
		null,
	);

	const members = roster.data?.members ?? [];
	const untrainedMembers = members.filter((m) => !m.trained);
	const activeLicenses = (licenses.data ?? []).filter(
		(l) => l.status === "active",
	);

	const isCancelled = training.status === "cancelled";
	const isTerminal = training.status === "completed" || isCancelled;

	const handleSchedule = () => {
		if (!scheduleDate) return;
		updateMutation.mutate(
			{
				trainingId: training.id,
				status: "scheduled",
				scheduledAt: scheduleDate.toISOString(),
			},
			{ onSuccess: () => scheduleHandlers.close() },
		);
	};

	const handleComplete = () => {
		if (selectedIds.length === 0) return;
		completeMutation.mutate(
			{
				trainingId: training.id,
				appUserIds: selectedIds,
				completedAt: completedDate ? completedDate.toISOString() : undefined,
			},
			{
				onSuccess: () => {
					completeHandlers.close();
					setSelectedIds([]);
					setCompletedDate(new Date());
				},
			},
		);
	};

	const handleCancel = () => {
		updateMutation.mutate(
			{ trainingId: training.id, status: "cancelled" },
			{ onSuccess: () => cancelHandlers.close() },
		);
	};

	const handleRevoke = () => {
		if (!revokeTarget) return;
		revokeMutation.mutate(revokeTarget.id, {
			onSuccess: () => setRevokeTarget(null),
		});
	};

	const handleReopen = () => {
		updateMutation.mutate({
			trainingId: training.id,
			status: training.scheduled_at ? "scheduled" : "requested",
		});
	};

	// Reset draft state on close so a reopened modal isn't showing a stale edit.
	const closeSchedule = () => {
		setScheduleDate(
			training.scheduled_at ? new Date(training.scheduled_at) : null,
		);
		scheduleHandlers.close();
	};

	const closeComplete = () => {
		setSelectedIds([]);
		setCompletedDate(new Date());
		setRevokeTarget(null);
		completeHandlers.close();
	};

	return (
		<>
			<Menu position="bottom-end" withinPortal>
				<Menu.Target>
					<ActionIcon variant="subtle" aria-label={t`Manage training`}>
						<DotsThreeVertical size={18} weight="bold" />
					</ActionIcon>
				</Menu.Target>
				<Menu.Dropdown>
					{isCancelled && (
						<Menu.Item onClick={handleReopen}>
							<Trans>Reopen</Trans>
						</Menu.Item>
					)}
					<Menu.Item onClick={scheduleHandlers.open} disabled={isTerminal}>
						{training.scheduled_at ? (
							<Trans>Reschedule</Trans>
						) : (
							<Trans>Schedule</Trans>
						)}
					</Menu.Item>
					<Menu.Item
						onClick={completeHandlers.open}
						disabled={isCancelled || !training.grants_license}
					>
						{training.status === "completed" ? (
							<Trans>Manage attendees</Trans>
						) : (
							<Trans>Mark completed</Trans>
						)}
					</Menu.Item>
					<Menu.Item
						color="red"
						onClick={cancelHandlers.open}
						disabled={isTerminal}
					>
						<Trans>Cancel training</Trans>
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			{/* Schedule */}
			<Modal
				opened={scheduleOpen}
				onClose={closeSchedule}
				title={t`Schedule training`}
			>
				<Stack gap="md">
					<DatePickerInput
						label={t`Training date`}
						placeholder={t`Pick a date`}
						value={scheduleDate}
						onChange={setScheduleDate}
						clearable
					/>
					<Group justify="flex-end" gap="sm">
						<Button variant="subtle" onClick={closeSchedule}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							onClick={handleSchedule}
							loading={updateMutation.isPending}
							disabled={!scheduleDate}
						>
							<Trans>Save</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Complete + grant licenses (additive) */}
			<Modal
				opened={completeOpen}
				onClose={closeComplete}
				title={
					training.status === "completed"
						? t`Manage attendees`
						: t`Mark training completed`
				}
				size="md"
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							Select who attended. Each gets a one-year license to use dembrane
							in high-risk settings.
						</Trans>
					</Text>

					{roster.isLoading ? (
						<Loader size="sm" />
					) : members.length > 0 ? (
						<Stack gap="sm">
							<Text size="sm" fw={500}>
								<Trans>
									{roster.data?.trained_count ?? activeLicenses.length} of{" "}
									{roster.data?.total_count ?? members.length} trained
								</Trans>
							</Text>

							{activeLicenses.length > 0 && (
								<Stack gap="xs">
									<Text size="xs" fw={500}>
										<Trans>Licenses granted</Trans>
									</Text>
									{activeLicenses.map((lic) => (
										<Group key={lic.id} justify="space-between" gap="sm">
											<Text size="sm">
												{lic.app_user_name || lic.app_user_id}
												{lic.expires_at ? (
													<>
														{" "}
														{t`until ${format(new Date(lic.expires_at), "d MMM yyyy")}`}
													</>
												) : null}
											</Text>
											<Button
												variant="subtle"
												color="red"
												size="xs"
												onClick={() => setRevokeTarget(lic)}
											>
												<Trans>Revoke</Trans>
											</Button>
										</Group>
									))}
								</Stack>
							)}

							{untrainedMembers.length > 0 ? (
								<Checkbox.Group
									value={selectedIds}
									onChange={setSelectedIds}
									label={t`Mark as attended`}
								>
									<Stack gap="xs" pt="xs">
										{untrainedMembers.map((m) => (
											<Checkbox
												key={m.app_user_id}
												value={m.app_user_id}
												label={m.display_name}
											/>
										))}
									</Stack>
								</Checkbox.Group>
							) : (
								<Text size="sm">
									<Trans>Everyone on the roster is trained.</Trans>
								</Text>
							)}
						</Stack>
					) : (
						<Text size="sm">
							<Trans>This organisation has no members to train yet.</Trans>
						</Text>
					)}

					<DatePickerInput
						label={t`Completed on`}
						value={completedDate}
						onChange={setCompletedDate}
					/>

					<Group justify="flex-end" gap="sm">
						<Button variant="subtle" onClick={closeComplete}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							onClick={handleComplete}
							loading={completeMutation.isPending}
							disabled={selectedIds.length === 0}
						>
							<Trans>Grant licenses</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Cancel */}
			<ConfirmModal
				opened={cancelOpen}
				onClose={cancelHandlers.close}
				onConfirm={handleCancel}
				title={t`Cancel training`}
				message={
					<Trans>
						This marks the training cancelled. You can reopen it later from the
						same menu.
					</Trans>
				}
				confirmLabel={<Trans>Cancel training</Trans>}
				cancelLabel={<Trans>Keep it</Trans>}
				confirmColor="red"
				loading={updateMutation.isPending}
				data-testid="training-cancel-modal"
			/>

			{/* Revoke a granted license (warning) */}
			<ConfirmModal
				opened={revokeTarget !== null}
				onClose={() => setRevokeTarget(null)}
				onConfirm={handleRevoke}
				title={t`Revoke license`}
				message={
					<Trans>
						This removes the one-year license for{" "}
						{revokeTarget?.app_user_name ?? "this person"}. They will no longer
						count as trained and lose access to high-risk settings. Only do this
						if the license was granted by mistake.
					</Trans>
				}
				confirmLabel={<Trans>Revoke license</Trans>}
				cancelLabel={<Trans>Keep license</Trans>}
				confirmColor="red"
				loading={revokeMutation.isPending}
				data-testid="license-revoke-modal"
			/>
		</>
	);
};
