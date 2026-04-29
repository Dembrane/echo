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
	inherit_organisation_admins?: boolean;
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
 * Four steps: Name → Tier → Access → Review. Back + cancel on each.
 *
 * Tier step is a pilot-only holding pattern today: every new workspace
 * starts on Pilot and upgrades happen via a sales conversation. The
 * step exists so the user sees "this starts on Pilot" as an explicit
 * acknowledgment rather than a surprise in billing later, and so the
 * step structure is ready for in-app tier selection once self-serve
 * upgrade lands.
 *
 * Access step gates Private on tier — Pilot can only create open
 * workspaces. The copy + disabled state explain the upgrade path.
 *
 * Multi-role lens:
 *   - Creator is always a organisation admin/owner (route-gated). Wizard
 *     copy centers on what OTHER roles experience once created.
 *   - Organisation admins: auto-discover; can Join directly.
 *   - Organisation members: auto-discover open; can Request access. Don't see
 *     private workspaces in discovery.
 *   - Guests: no organisation-scope presence. Only exist once explicitly
 *     invited; wizard doesn't cover that path (invite after create).
 *
 * Entry: `/w/new?organisationId=<org>`. Without organisationId, falls back to the
 * caller's primary admin organisation (with a quiet notice).
 *
 * Pre-checks mirror the old one-step flow:
 *   - Not onboarded → redirect to /onboarding.
 *   - No admin organisation → friendly "Ask your organisation admin" state.
 */
export const CreateWorkspaceRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { setWorkspace } = useWorkspace();
	const [searchParams] = useSearchParams();
	const organisationIdFromQuery = searchParams.get("organisationId") ?? null;
	const { data: meV2, isLoading: meLoading } = useV2Me();

	// Steps: 0 Name · 1 Tier · 2 Access · 3 Review. The Tier step is an
	// acknowledgment today (Pilot for everyone, upgrades route through
	// sales), so there's no tier state — when self-serve upgrade lands
	// this becomes a real select.
	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [privacy, setPrivacy] = useState<Privacy>("open");

	useDocumentTitle(t`New workspace | dembrane`);

	const adminOrganisations = useMemo(
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

	const targetOrganisationId = organisationIdFromQuery || adminOrganisations[0]?.id || null;
	const targetOrganisation = adminOrganisations.find((o) => o.id === targetOrganisationId) ?? null;

	const mutation = useMutation({
		mutationFn: () =>
			createWorkspace({
				name: name.trim(),
				org_id: targetOrganisationId ?? undefined,
				inherit_organisation_admins: privacy === "open",
			}),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "organisation"] });
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

	if (adminOrganisations.length === 0) {
		return (
			<Container size="xs" py="xl" px="lg">
				<Stack gap="md">
					<Title order={3} fw={400}>
						<Trans>You can't create a workspace yet</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							Only organisation admins and owners can create workspaces. Ask an admin
							on your organisation to create one, or ask them to promote you first.
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
	const canCreate = canAdvanceFromName && Boolean(targetOrganisationId);

	return (
		<Container size="sm" py="xl" px="lg">
			<Stack gap={28}>
				<Stack gap={6}>
					<Title order={3} fw={400}>
						<Trans>New workspace</Trans>
					</Title>
					{targetOrganisation && (
						<Text size="sm" c="dimmed">
							<Trans>
								Creating in <em>{targetOrganisation.name}</em>
							</Trans>
						</Text>
					)}
				</Stack>

				{organisationIdFromQuery && !targetOrganisation && (
					<Alert color="gray" variant="light">
						<Trans>
							You don't have permission to create workspaces in that organisation.
							Falling back to your primary organisation instead.
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

							{!organisationIdFromQuery && adminOrganisations.length > 1 && (
								<Select
									label={t`Organisation`}
									description={t`Which organisation does this workspace belong to?`}
									data={adminOrganisations.map((o) => ({
										value: o.id,
										label: o.name,
									}))}
									value={targetOrganisationId}
									onChange={(v) => {
										if (v)
											navigate(`/w/new?organisationId=${v}`, { replace: true });
									}}
									size="sm"
								/>
							)}
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Tier`}>
						<Stack gap={14} mt="md">
							<Text size="sm">
								<Trans>
									For now, new workspaces are created on <strong>Pilot</strong>.
									It's a one-month trial so you can see the product in action
									with your organisation.
								</Trans>
							</Text>
							<Alert color="gray" variant="light">
								<Stack gap={6}>
									<Text size="xs" fw={500}>
										<Trans>Need a higher tier?</Trans>
									</Text>
									<Text size="xs" c="dimmed">
										<Trans>
											Upgrades (Pioneer, Innovator, and beyond) are still a
											conversation. Reach out to dembrane and we'll set it up
											for your organisation.
										</Trans>
									</Text>
								</Stack>
							</Alert>
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
													<Trans>Open to the organisation</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Everyone on your organisation can find it. Admins
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
												<Text size="sm" c="dimmed">
													<Trans>Private</Trans>{" "}
													<Text span size="xs" c="dimmed">
														(<Trans>not available on Pilot</Trans>)
													</Text>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Only people you invite can see this workspace.
														Private workspaces unlock once you're on
														Innovator or higher.
													</Trans>
												</Text>
											</Stack>
										}
									/>
								</Stack>
							</Radio.Group>

							{/* Pilot → Open only. The disabled Radio above explains why;
							    this Alert tells the creator what to do about it without
							    pulling them out of the wizard. */}
							<Alert color="gray" variant="light">
								<Text size="xs">
									<Trans>
										Start open for now. Once your organisation upgrades, you can
										switch this workspace to private from its settings.
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
											<Trans>Organisation</Trans>
										</Text>
										<Text size="sm">
											{targetOrganisation?.name || t`(unknown)`}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={80}>
											<Trans>Access</Trans>
										</Text>
										<Text size="sm">
											{privacy === "open" ? (
												<Trans>Open to the organisation</Trans>
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
											<Trans>Pilot</Trans>
											<Text span c="dimmed" size="xs">
												{" · "}
												<Trans>one-month trial.</Trans>
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
										Organisation admins and members will find this workspace from
										their home page. Admins can join directly; members ask
										to join, and you approve.
									</Trans>
								) : (
									<Trans>
										Only people you invite will see this workspace. Organisation
										admins can still discover and join; organisation members can't
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
					{step < 3 ? (
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
