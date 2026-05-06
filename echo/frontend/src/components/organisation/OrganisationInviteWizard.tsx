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
	Loader,
	Modal,
	Paper,
	Radio,
	Stack,
	Stepper,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconLock, IconUserPlus } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { avatarUrl, memberInitials } from "@/lib/avatar";

export interface OrganisationInviteWizardWorkspace {
	id: string;
	name: string;
	tier: string;
	member_count: number;
	is_private?: boolean;
	// Cap-blocked flags from /v2/orgs/:id/workspaces. Org-level invites are
	// always is_org_member=true, so member_invite_blocked is the relevant
	// signal for whether this workspace card should be disabled.
	member_invite_blocked?: boolean;
	guest_invite_blocked?: boolean;
}

export interface OrganisationInviteWizardMember {
	app_user_id: string;
	display_name: string;
	avatar: string | null;
	// workspace_id → role mapping, used to derive avatar bubbles per
	// workspace card without a second round-trip.
	direct_workspace_roles?: Record<string, string>;
}

interface Props {
	opened: boolean;
	onClose: () => void;
	workspaces: OrganisationInviteWizardWorkspace[];
	// Existing organisation members — used to paint avatar bubbles on each
	// workspace card so the admin can eyeball who's already in.
	members: OrganisationInviteWizardMember[];
}

async function inviteToWorkspace(
	workspaceId: string,
	email: string,
	role: string,
) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, is_org_member: true, role }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to invite to workspace");
	}
	return res.json() as Promise<{
		status: string;
		email: string;
		email_sent: boolean;
	}>;
}

/**
 * Organisation-level invite wizard (2026-04-24 ask).
 *
 * Two steps: email + organisation role → pick workspaces.
 *
 * Organisation-scope invites don't exist as a single backend endpoint — the
 * matrix §3 model is that someone "joins the organisation" by joining their
 * first workspace. So this wizard fans out: it calls the workspace
 * invite endpoint with is_org_member=true for every selected workspace.
 * The first call creates the organisation membership; subsequent calls reuse it.
 *
 * Step 2 cards show tier + member count + a few avatar bubbles of
 * current members so the admin can eyeball who's already in without
 * leaving the flow.
 */
export function OrganisationInviteWizard({
	opened,
	onClose,
	workspaces,
	members,
}: Props) {
	const queryClient = useQueryClient();
	const [step, setStep] = useState(0);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// Per-workspace error messages from the last submit attempt. Keyed by
	// workspace_id. Lets us paint a red strip with the actual reason on
	// each failing card instead of the generic "couldn't send any" toast.
	const [errorByWorkspace, setErrorByWorkspace] = useState<
		Record<string, string>
	>({});

	const reset = () => {
		setStep(0);
		setEmail("");
		setRole("member");
		setSelected(new Set());
		setErrorByWorkspace({});
	};

	const handleClose = () => {
		reset();
		onClose();
	};

	const toggle = (id: string, disabled = false) => {
		if (disabled) return;
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setSelected(next);
		// Clear any stale per-workspace error on the row the user just
		// re-toggled so they don't see a red strip for a row they're no
		// longer about to submit (or have re-armed for a retry).
		if (errorByWorkspace[id]) {
			setErrorByWorkspace((prev) => {
				const copy = { ...prev };
				delete copy[id];
				return copy;
			});
		}
	};

	// Build "who's already in each workspace" previews from the organisation
	// members list. We take up to 4 avatars per workspace — one glance.
	const previewsByWorkspace = useMemo(() => {
		const map = new Map<string, OrganisationInviteWizardMember[]>();
		for (const ws of workspaces) {
			const people = members
				.filter((m) => m.direct_workspace_roles?.[ws.id])
				.slice(0, 4);
			map.set(ws.id, people);
		}
		return map;
	}, [workspaces, members]);

	const submit = useMutation({
		mutationFn: async () => {
			const targets = Array.from(selected);
			if (targets.length === 0) {
				throw new Error(t`Pick at least one workspace.`);
			}
			const results = await Promise.allSettled(
				targets.map((ws) => inviteToWorkspace(ws, email.trim(), role)),
			);
			// Capture {workspaceId, message} for every rejection so the
			// caller can show actual reasons (e.g. "An invite is already
			// pending for this email", "User is already a member") instead
			// of a generic try-again.
			const failed = results
				.map((r, i) =>
					r.status === "rejected"
						? {
								message:
									r.reason instanceof Error
										? r.reason.message
										: "Failed to invite",
								workspaceId: targets[i],
							}
						: null,
				)
				.filter((x): x is { workspaceId: string; message: string } =>
					Boolean(x),
				);
			const ok = results.length - failed.length;
			return { failed, ok };
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: ({ ok, failed }) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "organisation"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			// Persist per-workspace failures on the wizard so the cards
			// show the specific reason inline.
			const errMap: Record<string, string> = {};
			for (const f of failed) errMap[f.workspaceId] = f.message;
			setErrorByWorkspace(errMap);

			if (failed.length === 0) {
				toast.success(
					ok === 1
						? t`Invite sent to 1 workspace.`
						: t`Invites sent to ${ok} workspaces.`,
				);
				handleClose();
				return;
			}

			// Build a concrete toast that says *why* things failed instead of
			// "try again". If every failure shares the same reason (the
			// common case: "already pending" / "already a member"), surface
			// that reason directly.
			const distinctReasons = Array.from(new Set(failed.map((f) => f.message)));
			const reason =
				distinctReasons.length === 1
					? distinctReasons[0]
					: t`Multiple reasons (see workspace list).`;
			if (ok === 0) {
				toast.error(t`Couldn't send the invite. ${reason}`);
			} else {
				toast.error(
					t`Sent ${ok} of ${ok + failed.length}. ${failed.length === 1 ? failed[0].message : reason}`,
				);
			}
		},
	});

	const emailTrimmed = email.trim();
	const emailValid = emailTrimmed.length > 0 && emailTrimmed.includes("@");
	const canAdvanceFromEmail = emailValid;
	const canSubmit = emailValid && selected.size > 0;

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={<Trans>Invite someone to the organisation</Trans>}
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
					<Stepper.Step label={t`Who`}>
						<Stack gap={14} mt="md">
							<TextInput
								autoFocus
								label={t`Email address`}
								placeholder={t`name@example.com`}
								value={email}
								onChange={(e) => setEmail(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && canAdvanceFromEmail) {
										e.preventDefault();
										setStep(1);
									}
								}}
							/>
							<Radio.Group
								label={t`Organisation role`}
								description={t`You can change this later on the organisation People tab.`}
								value={role}
								onChange={(v) => setRole(v as "member" | "admin")}
							>
								<Stack gap={8} mt={6}>
									<Radio
										value="member"
										label={
											<Box>
												<Text size="sm">
													<Trans>Member</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Can see and work inside the workspaces you give them
														access to.
													</Trans>
												</Text>
											</Box>
										}
									/>
									<Radio
										value="admin"
										label={
											<Box>
												<Text size="sm">
													<Trans>Admin</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Can invite others, manage workspaces, and change
														roles across the organisation.
													</Trans>
												</Text>
											</Box>
										}
									/>
								</Stack>
							</Radio.Group>
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Workspaces`}>
						<Stack gap={10} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>
									Pick which workspaces this person should land in. They'll join
									the organisation through their first workspace.
								</Trans>
							</Text>

							{workspaces.length === 0 && (
								<Alert color="gray" variant="light">
									<Trans>
										No workspaces yet. Create one first, then come back to
										invite people.
									</Trans>
								</Alert>
							)}

							<Stack gap={8}>
								{workspaces.map((ws) => {
									const isSelected = selected.has(ws.id);
									const avatars = previewsByWorkspace.get(ws.id) ?? [];
									// Org invites add an organisation member to the workspace —
									// always a non-guest. Member cap is what matters here. The
									// guest cap doesn't gate org invites.
									const capBlocked = !!ws.member_invite_blocked;
									const wsError = errorByWorkspace[ws.id];
									const card = (
										<Paper
											key={ws.id}
											withBorder
											p="sm"
											radius="sm"
											onClick={() => toggle(ws.id, capBlocked)}
											style={{
												backgroundColor: isSelected
													? "var(--mantine-color-blue-0)"
													: undefined,
												borderColor: wsError
													? "var(--mantine-color-yellow-5)"
													: isSelected
														? "var(--mantine-color-blue-5)"
														: undefined,
												cursor: capBlocked ? "not-allowed" : "pointer",
												opacity: capBlocked ? 0.6 : 1,
											}}
										>
											<Stack gap={6}>
												<Group justify="space-between" wrap="nowrap">
													<Group gap={12} wrap="nowrap" style={{ minWidth: 0 }}>
														<Checkbox
															checked={isSelected}
															disabled={capBlocked}
															onChange={() => toggle(ws.id, capBlocked)}
															onClick={(e) => e.stopPropagation()}
															aria-label={t`Select ${ws.name}`}
														/>
														<Stack gap={2} style={{ minWidth: 0 }}>
															<Group gap={6} wrap="nowrap">
																<Text size="sm" fw={500} lineClamp={1}>
																	{ws.name}
																</Text>
																{ws.is_private && (
																	<IconLock
																		size={12}
																		style={{
																			color: "var(--mantine-color-gray-6)",
																		}}
																	/>
																)}
															</Group>
															<Group gap={6} wrap="nowrap">
																<Badge size="xs" variant="light" color="gray">
																	<span style={{ textTransform: "capitalize" }}>
																		{ws.tier}
																	</span>
																</Badge>
																<Text size="xs" c="dimmed">
																	<Plural
																		value={ws.member_count}
																		one="# member"
																		other="# members"
																	/>
																</Text>
																{capBlocked && (
																	<Badge
																		size="xs"
																		variant="light"
																		color="yellow"
																	>
																		<Trans>Seats full</Trans>
																	</Badge>
																)}
															</Group>
														</Stack>
													</Group>
													{avatars.length > 0 && (
														<Avatar.Group spacing="xs">
															{avatars.map((p) => (
																<Avatar
																	key={p.app_user_id}
																	size="sm"
																	radius="xl"
																	src={avatarUrl(p.avatar, 48)}
																	title={p.display_name}
																>
																	{memberInitials(p.display_name)}
																</Avatar>
															))}
														</Avatar.Group>
													)}
												</Group>
												{wsError && (
													<Text
														size="xs"
														c="yellow.8"
														style={{ paddingLeft: 32 }}
													>
														{wsError}
													</Text>
												)}
											</Stack>
										</Paper>
									);
									if (!capBlocked) return <Box key={ws.id}>{card}</Box>;
									return (
										<Tooltip
											key={ws.id}
											label={t`This workspace is at its seat limit on the ${ws.tier} tier. Free a seat by removing someone, or upgrade the workspace tier to invite more members.`}
											withArrow
											multiline
											w={300}
											position="top"
											events={{ focus: true, hover: true, touch: true }}
										>
											<Box>{card}</Box>
										</Tooltip>
									);
								})}
							</Stack>
						</Stack>
					</Stepper.Step>
				</Stepper>

				<Group justify="space-between">
					<Button
						variant="outline"
						size="sm"
						onClick={step === 0 ? handleClose : () => setStep(step - 1)}
					>
						{step === 0 ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
					</Button>
					{step === 0 ? (
						<Button
							size="sm"
							disabled={!canAdvanceFromEmail}
							onClick={() => setStep(1)}
							leftSection={<IconUserPlus size={14} />}
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
							{submit.isPending ? (
								<Loader size="xs" />
							) : selected.size > 1 ? (
								<Trans>Send {selected.size} invites</Trans>
							) : (
								<Trans>Send invite</Trans>
							)}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
