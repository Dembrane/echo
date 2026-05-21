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

interface OrganisationMember {
	user_id: string;
	app_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	role: string;
}

async function fetchOrganisationMembers(
	orgId: string,
): Promise<OrganisationMember[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/members`, {
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: `Members request failed (${res.status})`,
		);
	}
	return res.json();
}

async function inviteToWorkspace(
	workspaceId: string,
	email: string,
	role: string,
): Promise<{ status: string; email: string; email_sent: boolean }> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, role }),
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
	role: "external";
}

interface Props {
	opened: boolean;
	onClose: () => void;
	workspaceId: string;
	orgId: string;
	// Existing workspace members — so we can filter organisation members who
	// are already in and hide them from the picker.
	existingMemberAppUserIds: Set<string>;
	// Cap-blocked flags from the workspace usage endpoint. When true, the
	// corresponding step is disabled with an upgrade prompt instead of
	// letting the user fill the form only to fail at submit.
	memberInviteBlocked?: boolean;
	externalInviteBlocked?: boolean;
	// True when the workspace is on a Pioneer+ tier and already at or over
	// included seats. Picker stays enabled (overage is allowed), but we
	// surface a soft warning so admins know each new member adds to the
	// monthly bill.
	memberOverageActive?: boolean;
	// Per-seat overage rate (€/month). Null on tiers that don't bill
	// overage (Pilot, Guardian).
	seatOverageRate?: number | null;
}

/**
 * Workspace-level invite wizard (2026-04-24 ask).
 *
 * Two steps: pick organisation members → add externals.
 *
 * The old modal was a single email-at-a-time form. This wizard lets
 * admins bring in multiple organisation members in one go (the common case —
 * "add Alice and Bob to this workspace") and still lets them invite
 * externals through a similar add-rows UI in step 2.
 *
 * Submit fans out to the existing per-email invite endpoint; the
 * backend handles "already organisation member? skip org_membership"
 * and writes role='external' on the membership/invite row.
 */
export function WorkspaceInviteWizard({
	opened,
	onClose,
	workspaceId,
	orgId,
	existingMemberAppUserIds,
	memberInviteBlocked = false,
	externalInviteBlocked = false,
	memberOverageActive = false,
	seatOverageRate = null,
}: Props) {
	const queryClient = useQueryClient();
	const [step, setStep] = useState(0);
	const [selectedOrganisationMembers, setSelectedOrganisationMembers] =
		useState<Set<string>>(new Set());
	const [role, setRole] = useState<"member" | "billing" | "admin">("member");
	const [externals, setExternals] = useState<ExternalRow[]>([]);

	const {
		data: organisationMembers,
		isLoading,
		isError: membersError,
		refetch: refetchMembers,
	} = useQuery({
		enabled: opened && Boolean(orgId),
		queryFn: () => fetchOrganisationMembers(orgId),
		queryKey: ["v2", "organisation-members", orgId],
		staleTime: 30_000,
	});

	const availableOrganisationMembers = useMemo(() => {
		if (!organisationMembers) return [];
		// People not already in this workspace. Externals (no org_membership,
		// only reachable via external workspace rows) are excluded here —
		// step 1 is for real org members; externals belong in step 2.
		return organisationMembers.filter(
			(m) =>
				!existingMemberAppUserIds.has(m.app_user_id) && m.role !== "external",
		);
	}, [organisationMembers, existingMemberAppUserIds]);

	const reset = () => {
		setStep(0);
		setSelectedOrganisationMembers(new Set());
		setRole("member");
		setExternals([]);
	};

	const handleClose = () => {
		reset();
		onClose();
	};

	const toggleOrganisationMember = (email: string) => {
		const next = new Set(selectedOrganisationMembers);
		if (next.has(email)) next.delete(email);
		else next.add(email);
		setSelectedOrganisationMembers(next);
	};

	const addExternalRow = () => {
		setExternals((prev) => [
			...prev,
			{
				email: "",
				id: Math.random().toString(36).slice(2),
				role: "external",
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
			const organisationEmails = Array.from(selectedOrganisationMembers);
			const externalEmails = externals
				.map((r) => r.email.trim())
				.filter((e) => e.length > 0 && e.includes("@"));

			if (organisationEmails.length + externalEmails.length === 0) {
				throw new Error(t`Pick at least one member or add an email.`);
			}

			const calls: ReturnType<typeof inviteToWorkspace>[] = [];
			for (const email of organisationEmails) {
				calls.push(inviteToWorkspace(workspaceId, email, role));
			}
			for (const email of externalEmails) {
				calls.push(inviteToWorkspace(workspaceId, email, "external"));
			}

			const results = await Promise.allSettled(calls);
			const ok = results.filter((r) => r.status === "fulfilled").length;
			const failed = results.length - ok;
			// Row was created but the broker refused the email — admin must resend.
			const emailFailed = results.filter(
				(r) => r.status === "fulfilled" && r.value.email_sent === false,
			).length;
			return { emailFailed, failed, ok, total: results.length };
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: ({ ok, failed, emailFailed, total }) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation-members", orgId],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "organisation", orgId, "members"],
			});
			// Refresh seat cap flags after invites land.
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-usage", workspaceId, 0],
			});
			if (failed === 0 && emailFailed === 0) {
				toast.success(ok === 1 ? t`Invite sent.` : t`${ok} invites sent.`);
				handleClose();
			} else if (failed === 0 && emailFailed > 0) {
				// Two static variants instead of inline `s` — non-English plurals don't survive that.
				const partialMsg =
					emailFailed === 1
						? t`Added ${ok}, but 1 email didn't go out. Resend from the Members tab.`
						: t`Added ${ok}, but ${emailFailed} emails didn't go out. Resend from the Members tab.`;
				toast.error(
					emailFailed === ok
						? t`Added, but the invite email didn't go out. Resend it from the Members tab.`
						: partialMsg,
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
	});

	const hasMemberPicks = selectedOrganisationMembers.size > 0;
	const hasExternalPicks = externals.some(
		(r) => r.email.trim().length > 0 && r.email.includes("@"),
	);
	// Pre-flight: don't even let them submit picks the backend will 402 on.
	const memberPicksWillFail = hasMemberPicks && memberInviteBlocked;
	const externalPicksWillFail = hasExternalPicks && externalInviteBlocked;
	const canSubmit =
		(hasMemberPicks || hasExternalPicks) &&
		!memberPicksWillFail &&
		!externalPicksWillFail;

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={step === 0 ? <Trans>Invite members</Trans> : <Trans>Invite externals</Trans>}
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
					<Stepper.Step label={t`Your organisation`}>
						<Stack gap={12} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>Pick members to bring into this workspace.</Trans>
							</Text>

							{memberInviteBlocked && (
								<Alert color="yellow" variant="light">
									<Text size="sm" fw={500}>
										<Trans>Member seats full on this tier</Trans>
									</Text>
									<Text size="xs" c="dimmed" mt={4}>
										<Trans>
											Free a seat by removing someone, or upgrade to add more
											members. You can still invite externals in the next step.
										</Trans>
									</Text>
								</Alert>
							)}

							{!memberInviteBlocked && memberOverageActive && (
								<Alert color="blue" variant="light">
									<Text size="sm" fw={500}>
										<Trans>Heads up: overage applies</Trans>
									</Text>
									<Text size="xs" c="dimmed" mt={4}>
										{seatOverageRate != null ? (
											<Trans>
												You're over your included seats. Each new member adds €
												{seatOverageRate}/month to next bill. Upgrade to a
												higher tier if you'd rather not pay overage.
											</Trans>
										) : (
											<Trans>
												You're over your included seats. Overage applies on the
												next bill.
											</Trans>
										)}
									</Text>
								</Alert>
							)}

							{isLoading && (
								<Text size="sm" c="dimmed">
									<Trans>Loading your organisation…</Trans>
								</Text>
							)}

							{/* Otherwise the empty-picker copy below masks a real fetch failure. */}
							{membersError && (
								<Alert color="red" variant="light">
									<Stack gap="xs">
										<Text size="sm">
											<Trans>
												We couldn't load your organisation's members.
											</Trans>
										</Text>
										<Button
											size="xs"
											variant="default"
											onClick={() => refetchMembers()}
										>
											<Trans>Retry</Trans>
										</Button>
									</Stack>
								</Alert>
							)}

							{!isLoading &&
								!membersError &&
								availableOrganisationMembers.length === 0 &&
								!memberInviteBlocked && (
									<Alert color="gray" variant="light">
										<Trans>
											Everyone from your organisation is already in this
											workspace. Invite externals in the next step.
										</Trans>
									</Alert>
								)}

							{availableOrganisationMembers.length > 0 &&
								!memberInviteBlocked && (
									<Stack gap={6}>
										{availableOrganisationMembers.map((m) => {
											const checked = selectedOrganisationMembers.has(m.email);
											return (
												<Paper
													key={m.user_id}
													withBorder
													p="sm"
													radius="sm"
													onClick={() => toggleOrganisationMember(m.email)}
													style={{
														backgroundColor: checked
															? "var(--mantine-color-blue-0)"
															: undefined,
														borderColor: checked
															? "var(--mantine-color-blue-5)"
															: undefined,
														cursor: "pointer",
													}}
												>
													<Group gap={12} wrap="nowrap">
														<Checkbox
															checked={checked}
															onChange={() => toggleOrganisationMember(m.email)}
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
							    Step 2 always submits role='external'. */}
							{selectedOrganisationMembers.size > 0 && !memberInviteBlocked && (
								<Paper withBorder p="sm" radius="sm">
									<Radio.Group
										label={t`Workspace role`}
										description={t`Applies to the members you picked.`}
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

							{selectedOrganisationMembers.size > 0 && !memberInviteBlocked && (
								<Text size="xs" c="dimmed">
									<Plural
										value={selectedOrganisationMembers.size}
										one="# member selected"
										other="# members selected"
									/>
								</Text>
							)}
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Invite externals`}>
						<Stack gap={12} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>
									Invite people outside your organisation. They get
									workspace-only access and count toward the seat pool.
								</Trans>
							</Text>

							{externalInviteBlocked && (
								<Alert color="yellow" variant="light">
									<Text size="sm" fw={500}>
										<Trans>All seats taken on this tier</Trans>
									</Text>
									<Text size="xs" c="dimmed" mt={4}>
										<Trans>
											Remove a member or external, or upgrade to invite more
											people.
										</Trans>
									</Text>
								</Alert>
							)}

							{!externalInviteBlocked && externals.length === 0 && (
								<Alert color="gray" variant="light">
									<Trans>
										No externals yet. Add one if you want someone outside your
										organisation to join this workspace.
									</Trans>
								</Alert>
							)}

							{!externalInviteBlocked && externals.length > 0 && (
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

							{!externalInviteBlocked && (
								<Button
									size="sm"
									variant="default"
									leftSection={<IconPlus size={14} />}
									onClick={addExternalRow}
								>
									<Trans>Add an external</Trans>
								</Button>
							)}
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
						<Button
							size="sm"
							onClick={() => {
								if (externals.length === 0 && !externalInviteBlocked) {
									addExternalRow();
								}
								setStep(1);
							}}
						>
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
