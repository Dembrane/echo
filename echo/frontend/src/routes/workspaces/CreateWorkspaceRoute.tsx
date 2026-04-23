import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	Group,
	List,
	Loader,
	Paper,
	Radio,
	Select,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";

async function createWorkspace(payload: {
	name: string;
	org_id?: string;
	inherit_team_admins?: boolean;
}) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		body: JSON.stringify(payload),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to create workspace");
	}
	return res.json();
}

type Privacy = "open" | "private";

/**
 * Workspace creation wizard — matrix §6 Slack-style model.
 *
 * Three steps with back + cancel on each. The review step spells out
 * what EVERY role (team admin, team member, guest) will experience in
 * the new workspace so the creator isn't surprised later.
 *
 * Multi-role lens:
 *   - Creator is always a team admin/owner (route-gated). Wizard
 *     copy centers on what OTHER roles experience once created.
 *   - Team admins: auto-discover; can Join directly.
 *   - Team members: auto-discover open; can Request access. Don't see
 *     private workspaces in discovery.
 *   - Guests: no team-scope presence. Only exist once explicitly
 *     invited; wizard doesn't cover that path (invite after create).
 *
 * Entry: `/w/new?teamId=<org>`. Without teamId, falls back to the
 * caller's primary admin team (with a quiet notice).
 *
 * Pre-checks mirror the old one-step flow:
 *   - Not onboarded → redirect to /onboarding.
 *   - No admin team → friendly "Ask your team admin" state.
 */
export const CreateWorkspaceRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { setWorkspace } = useWorkspace();
	const [searchParams] = useSearchParams();
	const teamIdFromQuery = searchParams.get("teamId") ?? null;
	const { data: meV2, isLoading: meLoading } = useV2Me();

	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [privacy, setPrivacy] = useState<Privacy>("open");

	useDocumentTitle(t`New workspace | dembrane`);

	const adminTeams = useMemo(
		() =>
			(meV2?.orgs ?? []).filter(
				(o) => o.role === "owner" || o.role === "admin",
			),
		[meV2],
	);

	useEffect(() => {
		if (meLoading) return;
		if (meV2 && meV2.onboarding_completed === false) {
			navigate("/onboarding");
		}
	}, [meLoading, meV2, navigate]);

	const targetTeamId = teamIdFromQuery || adminTeams[0]?.id || null;
	const targetTeam = adminTeams.find((o) => o.id === targetTeamId) ?? null;

	const mutation = useMutation({
		mutationFn: () =>
			createWorkspace({
				name: name.trim(),
				org_id: targetTeamId ?? undefined,
				inherit_team_admins: privacy === "open",
			}),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "team"] });
			setWorkspace(data.id);
			toast.success(t`Workspace created`);
			navigate(`/w/${data.id}/projects`);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleCancel = () => {
		// Confirm only if the user has typed a name — empty forms should
		// cancel silently. Consistent with most wizards users have seen.
		if (name.trim()) {
			modals.openConfirmModal({
				title: t`Discard this workspace?`,
				children: (
					<Text size="sm">
						<Trans>Your draft won't be saved.</Trans>
					</Text>
				),
				labels: { confirm: t`Discard`, cancel: t`Keep editing` },
				confirmProps: { color: "red" },
				onConfirm: () => navigate("/w"),
			});
		} else {
			navigate("/w");
		}
	};

	if (meLoading || meV2?.onboarding_completed === false) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	if (adminTeams.length === 0) {
		return (
			<Container size="xs" py="xl" px="lg">
				<Stack gap="md">
					<Title order={3} fw={400}>
						<Trans>You can't create a workspace yet</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							Only team admins and owners can create workspaces. Ask an admin
							on your team to create one, or ask them to promote you first.
						</Trans>
					</Text>
					<Group>
						<Button variant="default" onClick={() => navigate("/w")}>
							<Trans>Back</Trans>
						</Button>
					</Group>
				</Stack>
			</Container>
		);
	}

	const canAdvanceFromName = name.trim().length > 0;
	const canCreate = canAdvanceFromName && Boolean(targetTeamId);

	return (
		<Container size="sm" py="xl" px="lg">
			<Stack gap={28}>
				<Stack gap={6}>
					<Title order={3} fw={400}>
						<Trans>New workspace</Trans>
					</Title>
					{targetTeam && (
						<Text size="sm" c="dimmed">
							<Trans>
								Creating in <em>{targetTeam.name}</em>
							</Trans>
						</Text>
					)}
				</Stack>

				{teamIdFromQuery && !targetTeam && (
					<Alert color="gray" variant="light">
						<Trans>
							You don't have permission to create workspaces in that team.
							Falling back to your primary team instead.
						</Trans>
					</Alert>
				)}

				<Stepper
					active={step}
					onStepClick={(i) => {
						// Let the user jump backwards only. Jumping forward past
						// an incomplete step is what the Next button is for.
						if (i <= step) setStep(i);
					}}
					size="sm"
					iconSize={28}
				>
					<Stepper.Step label={t`Name`}>
						<Stack gap={16} mt="md">
							<TextInput
								autoFocus
								label={t`Workspace name`}
								description={t`Name it after the client, engagement, or purpose.`}
								placeholder={t`e.g. Client Alpha, Q1 Research`}
								value={name}
								onChange={(e) => setName(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && canAdvanceFromName) {
										e.preventDefault();
										setStep(1);
									}
								}}
							/>

							{!teamIdFromQuery && adminTeams.length > 1 && (
								<Select
									label={t`Team`}
									description={t`Which team does this workspace belong to?`}
									data={adminTeams.map((o) => ({
										value: o.id,
										label: o.name,
									}))}
									value={targetTeamId}
									onChange={(v) => {
										if (v)
											navigate(`/w/new?teamId=${v}`, { replace: true });
									}}
									size="sm"
								/>
							)}
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Access`}>
						<Stack gap={14} mt="md">
							<Radio.Group
								label={t`Who can see this workspace?`}
								description={t`You can change this later in workspace settings.`}
								value={privacy}
								onChange={(v) => setPrivacy(v as Privacy)}
							>
								<Stack gap={10} mt={8}>
									<Radio
										value="open"
										label={
											<Stack gap={2}>
												<Text size="sm">
													<Trans>Open to the team</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Everyone on your team can find it. Admins
														can join directly; members can ask to join.
													</Trans>
												</Text>
											</Stack>
										}
									/>
									<Radio
										value="private"
										disabled
										label={
											<Stack gap={2}>
												<Text size="sm">
													<Trans>Private</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Only people you explicitly invite. Available on
														innovator and above.
													</Trans>
												</Text>
											</Stack>
										}
									/>
								</Stack>
							</Radio.Group>

							{/* Upgrade path when Private is what you want. Wizard
							    doesn't try to handle billing mid-flow — finish this
							    open workspace, then upgrade + flip from settings. */}
							<Alert color="gray" variant="light">
								<Text size="xs">
									<Trans>
										Need a private workspace? Start open, upgrade to
										innovator, and switch to private from the workspace's
										billing tab.
									</Trans>
								</Text>
							</Alert>
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Review`}>
						<Stack gap={14} mt="md">
							<Paper withBorder p="md" radius="sm">
								<Stack gap={10}>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={80}>
											<Trans>Name</Trans>
										</Text>
										<Text size="sm" fw={500}>
											{name.trim() || t`(missing)`}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={80}>
											<Trans>Team</Trans>
										</Text>
										<Text size="sm">
											{targetTeam?.name || t`(unknown)`}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={80}>
											<Trans>Access</Trans>
										</Text>
										<Text size="sm">
											{privacy === "open" ? (
												<Trans>Open to the team</Trans>
											) : (
												<Trans>Private</Trans>
											)}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={80}>
											<Trans>Tier</Trans>
										</Text>
										<Text size="sm">
											<Trans>Pioneer</Trans>
											<Text span c="dimmed" size="xs">
												{" · "}
												<Trans>for your first real engagements.</Trans>
											</Text>
										</Text>
									</Group>
								</Stack>
							</Paper>

							{/* Lighter "who else will see this" note — spells out the
							    matrix §6 discovery model without the heavy per-role
							    breakdown the earlier draft had. */}
							<Text size="xs" c="dimmed">
								{privacy === "open" ? (
									<Trans>
										Team admins and members will find this workspace from
										their home page. Admins can Join directly; members ask
										to join — you approve.
									</Trans>
								) : (
									<Trans>
										Only people you invite will see this workspace. Team
										admins can still discover and join; team members can't
										see it at all.
									</Trans>
								)}
							</Text>
						</Stack>
					</Stepper.Step>
				</Stepper>

				<Group justify="space-between" mt="sm">
					<Button
						variant="default"
						size="sm"
						onClick={step === 0 ? handleCancel : () => setStep(step - 1)}
					>
						{step === 0 ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
					</Button>
					{step < 2 ? (
						<Button
							size="sm"
							disabled={step === 0 && !canAdvanceFromName}
							onClick={() => setStep(step + 1)}
						>
							<Trans>Next</Trans>
						</Button>
					) : (
						<Button
							size="sm"
							loading={mutation.isPending}
							disabled={!canCreate}
							onClick={() => mutation.mutate()}
						>
							<Trans>Create workspace</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</Container>
	);
};
