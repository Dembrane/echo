import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Alert,
	Avatar,
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Modal,
	Paper,
	Radio,
	Stack,
	Stepper,
	Text,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { avatarUrl, memberInitials } from "@/lib/avatar";

interface TeamMember {
	user_id: string;
	app_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	role: string;
}

async function fetchTeamMembers(orgId: string): Promise<TeamMember[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/members`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

async function inviteToWorkspace(
	workspaceId: string,
	email: string,
	role: string,
	isOrgMember: boolean,
) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, role, is_org_member: isOrgMember }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to send invite");
	}
	return res.json();
}

interface ExternalRow {
	id: string;
	email: string;
	role: "member";
}

interface Props {
	opened: boolean;
	onClose: () => void;
	workspaceId: string;
	orgId: string;
	// Existing workspace members — so we can filter team members who
	// are already in and hide them from the picker.
	existingMemberAppUserIds: Set<string>;
}

/**
 * Workspace-level invite wizard (2026-04-24 ask).
 *
 * Two steps: pick team members → add externals.
 *
 * The old modal was a single email-at-a-time form. This wizard lets
 * admins bring in multiple team members in one go (the common case —
 * "add Alice and Bob to this workspace") and still lets them invite
 * externals through a similar add-rows UI in step 2.
 *
 * Submit fans out to the existing per-email invite endpoint; the
 * backend already handles "already team member? skip org_membership"
 * and guest-clamp-to-member, so nothing new is needed on the server.
 */
export function WorkspaceInviteWizard({
	opened,
	onClose,
	workspaceId,
	orgId,
	existingMemberAppUserIds,
}: Props) {
	const queryClient = useQueryClient();
	const [step, setStep] = useState(0);
	const [selectedTeamMembers, setSelectedTeamMembers] = useState<Set<string>>(
		new Set(),
	);
	const [role, setRole] = useState<"member" | "billing" | "admin">("member");
	const [externals, setExternals] = useState<ExternalRow[]>([]);

	const { data: teamMembers, isLoading } = useQuery({
		queryKey: ["v2", "team-members", orgId],
		queryFn: () => fetchTeamMembers(orgId),
		enabled: opened && Boolean(orgId),
		staleTime: 30_000,
	});

	const availableTeamMembers = useMemo(() => {
		if (!teamMembers) return [];
		// People not already in this workspace.
		return teamMembers.filter(
			(m) => !existingMemberAppUserIds.has(m.app_user_id),
		);
	}, [teamMembers, existingMemberAppUserIds]);

	const reset = () => {
		setStep(0);
		setSelectedTeamMembers(new Set());
		setRole("member");
		setExternals([]);
	};

	const handleClose = () => {
		reset();
		onClose();
	};

	const toggleTeamMember = (email: string) => {
		const next = new Set(selectedTeamMembers);
		if (next.has(email)) next.delete(email);
		else next.add(email);
		setSelectedTeamMembers(next);
	};

	const addExternalRow = () => {
		setExternals((prev) => [
			...prev,
			{
				id: Math.random().toString(36).slice(2),
				email: "",
				role: "member",
			},
		]);
	};

	const updateExternal = (id: string, email: string) => {
		setExternals((prev) =>
			prev.map((r) => (r.id === id ? { ...r, email } : r)),
		);
	};

	const removeExternal = (id: string) => {
		setExternals((prev) => prev.filter((r) => r.id !== id));
	};

	const submit = useMutation({
		mutationFn: async () => {
			const teamEmails = Array.from(selectedTeamMembers);
			const externalEmails = externals
				.map((r) => r.email.trim())
				.filter((e) => e.length > 0 && e.includes("@"));

			if (teamEmails.length + externalEmails.length === 0) {
				throw new Error(t`Pick at least one teammate or add an email.`);
			}

			const calls: Promise<unknown>[] = [];
			for (const email of teamEmails) {
				calls.push(inviteToWorkspace(workspaceId, email, role, true));
			}
			for (const email of externalEmails) {
				// Guests are clamped to 'member' on the backend regardless; we
				// send member here so the UI matches.
				calls.push(inviteToWorkspace(workspaceId, email, "member", false));
			}

			const results = await Promise.allSettled(calls);
			const ok = results.filter((r) => r.status === "fulfilled").length;
			const failed = results.length - ok;
			return { ok, failed, total: results.length };
		},
		onSuccess: ({ ok, failed, total }) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "team-members", orgId] });
			if (failed === 0) {
				toast.success(
					ok === 1
						? t`Invite sent.`
						: t`${ok} invites sent.`,
				);
				handleClose();
			} else if (ok === 0) {
				toast.error(t`Couldn't send any of the invites. Try again.`);
			} else {
				toast.error(
					t`Sent ${ok} of ${total}. Check the list and retry the rest.`,
				);
			}
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const canSubmit =
		selectedTeamMembers.size > 0 ||
		externals.some((r) => r.email.trim().length > 0 && r.email.includes("@"));

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={<Trans>Invite members</Trans>}
			centered
			size="lg"
		>
			<Stack gap={20}>
				<Stepper
					active={step}
					onStepClick={(i) => {
						if (i <= step) setStep(i);
					}}
					size="sm"
					iconSize={28}
				>
					<Stepper.Step label={t`Your team`}>
						<Stack gap={12} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>
									Pick teammates to bring into this workspace. They'll keep
									their team seat — no extra cost.
								</Trans>
							</Text>

							{isLoading && (
								<Text size="sm" c="dimmed">
									<Trans>Loading your team…</Trans>
								</Text>
							)}

							{!isLoading && availableTeamMembers.length === 0 && (
								<Alert color="gray" variant="light">
									<Trans>
										Everyone on your team is already in this workspace.
										Invite externals in the next step.
									</Trans>
								</Alert>
							)}

							{availableTeamMembers.length > 0 && (
								<Stack gap={6}>
									{availableTeamMembers.map((m) => {
										const checked = selectedTeamMembers.has(m.email);
										return (
											<Paper
												key={m.user_id}
												withBorder
												p="sm"
												radius="sm"
												onClick={() => toggleTeamMember(m.email)}
												style={{
													cursor: "pointer",
													borderColor: checked
														? "var(--mantine-color-blue-5)"
														: undefined,
													backgroundColor: checked
														? "var(--mantine-color-blue-0)"
														: undefined,
												}}
											>
												<Group gap={12} wrap="nowrap">
													<Checkbox
														checked={checked}
														onChange={() => toggleTeamMember(m.email)}
														onClick={(e) => e.stopPropagation()}
														aria-label={t`Select ${m.display_name}`}
													/>
													<Avatar
														size={32}
														radius="xl"
														src={avatarUrl(m.avatar, 48)}
													>
														{memberInitials(m.display_name, m.email)}
													</Avatar>
													<Box style={{ flex: 1, minWidth: 0 }}>
														<Text size="sm" lineClamp={1}>
															{m.display_name || m.email}
														</Text>
														<Text size="xs" c="dimmed" lineClamp={1}>
															{m.email}
														</Text>
													</Box>
													<Badge
														size="xs"
														variant="light"
														color="gray"
														style={{ textTransform: "capitalize" }}
													>
														{m.role}
													</Badge>
												</Group>
											</Paper>
										);
									})}
								</Stack>
							)}

							{/* Role picker — applies to everyone selected in step 1.
							    Externals in step 2 are always 'member' (guest clamp). */}
							{selectedTeamMembers.size > 0 && (
								<Paper withBorder p="sm" radius="sm">
									<Radio.Group
										label={t`Workspace role`}
										description={t`Applies to the teammates you picked.`}
										value={role}
										onChange={(v) =>
											setRole(v as "member" | "billing" | "admin")
										}
									>
										<Stack gap={8} mt={6}>
											<Radio
												value="member"
												label={
													<Text size="sm">
														<Trans>Member — can create and collaborate</Trans>
													</Text>
												}
											/>
											<Radio
												value="billing"
												label={
													<Text size="sm">
														<Trans>
															Billing — sees usage and invoices only
														</Trans>
													</Text>
												}
											/>
											<Radio
												value="admin"
												label={
													<Text size="sm">
														<Trans>
															Admin — manage the workspace and its members
														</Trans>
													</Text>
												}
											/>
										</Stack>
									</Radio.Group>
								</Paper>
							)}

							{selectedTeamMembers.size > 0 && (
								<Text size="xs" c="dimmed">
									<Plural
										value={selectedTeamMembers.size}
										one="# teammate selected"
										other="# teammates selected"
									/>
								</Text>
							)}
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Externals`}>
						<Stack gap={12} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>
									Invite people outside your team. They get workspace-only
									access and don't use a team seat.
								</Trans>
							</Text>

							{externals.length === 0 ? (
								<Alert color="gray" variant="light">
									<Trans>
										No externals yet. Add one if you want someone outside
										your team to join this workspace.
									</Trans>
								</Alert>
							) : (
								<Stack gap={8}>
									{externals.map((row) => (
										<Group key={row.id} gap={8} wrap="nowrap">
											<TextInput
												placeholder={t`name@example.com`}
												value={row.email}
												onChange={(e) =>
													updateExternal(row.id, e.currentTarget.value)
												}
												style={{ flex: 1 }}
											/>
											<Button
												variant="subtle"
												color="red"
												size="sm"
												onClick={() => removeExternal(row.id)}
												leftSection={<IconTrash size={14} />}
											>
												<Trans>Remove</Trans>
											</Button>
										</Group>
									))}
								</Stack>
							)}

							<Button
								size="sm"
								variant="default"
								leftSection={<IconPlus size={14} />}
								onClick={addExternalRow}
							>
								<Trans>Add an external</Trans>
							</Button>
						</Stack>
					</Stepper.Step>
				</Stepper>

				<Group justify="space-between">
					<Button
						variant="default"
						size="sm"
						onClick={step === 0 ? handleClose : () => setStep(step - 1)}
					>
						{step === 0 ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
					</Button>
					{step === 0 ? (
						<Button size="sm" onClick={() => setStep(1)}>
							<Trans>Next</Trans>
						</Button>
					) : (
						<Button
							size="sm"
							disabled={!canSubmit}
							loading={submit.isPending}
							onClick={() => submit.mutate()}
						>
							<Trans>Send invites</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
