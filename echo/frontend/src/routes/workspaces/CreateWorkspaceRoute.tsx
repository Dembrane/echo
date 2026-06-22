import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	Group,
	Loader,
	MultiSelect,
	Paper,
	Radio,
	Select,
	SimpleGrid,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { Buildings, Lock, UsersThree } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";

interface CreatedWorkspace {
	id: string;
	name: string;
}

async function createWorkspace(payload: {
	name: string;
	org_id: string;
	inherit_organisation_admins: boolean;
	// No bill_separately flag: naming a data owner (org + rep email) is what
	// makes the workspace external / separately billed (the server derives it).
	data_owner_org_name?: string;
	data_owner_email?: string;
	partner_agreement_accepted?: boolean;
}): Promise<CreatedWorkspace> {
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

// Add an existing org member to the freshly-created workspace. Reuses the
// workspace invite endpoint, which adds existing users as members directly.
async function addWorkspaceMember(workspaceId: string, email: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, role: "member" }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to add member");
	}
	return res.json();
}

interface OrgMemberRow {
	app_user_id: string;
	email: string;
	display_name: string;
	role: string;
	is_external?: boolean;
}

// "everyone" = open to org; "invite" = private + hand-pick members; "just_me" =
// private with no one else. The last two both create a private workspace
// (inherit_organisation_admins=false); they differ only in who gets added.
type Access = "everyone" | "invite" | "just_me";
type BillFor = "internal" | "client";

/**
 * Self-serve workspace creation.
 *
 * Steps: Name → Ownership → Access → Review. Org admins/owners create directly
 * (no staff approval). By default the workspace joins the org's billing
 * account ("internal"). Partners (org.is_partner) get a second choice — "for
 * another client" — which bills the workspace on its own account, handoff-ready;
 * they finish by subscribing it on its billing tab.
 *
 * Entry: `/w/new?organisationId=<org>`. Without it, falls back to the caller's
 * primary admin organisation.
 */
export const CreateWorkspaceRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { setWorkspace } = useWorkspace();
	const [searchParams] = useSearchParams();
	const organisationIdFromQuery = searchParams.get("organisationId") ?? null;
	const { data: meV2, isLoading: meLoading } = useV2Me();

	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [access, setAccess] = useState<Access>("everyone");
	const [memberEmails, setMemberEmails] = useState<string[]>([]);
	const [billFor, setBillFor] = useState<BillFor>("internal");
	// External-client (ISSUE-026): owning-org name + data owner rep.
	const [dataOwnerOrgName, setDataOwnerOrgName] = useState("");
	const [dataOwnerEmail, setDataOwnerEmail] = useState("");

	useDocumentTitle(t`Create workspace | dembrane`);

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

	const targetOrganisationId =
		organisationIdFromQuery || adminOrganisations[0]?.id || null;
	const targetOrganisation =
		adminOrganisations.find((o) => o.id === targetOrganisationId) ?? null;

	// Existing org members the creator can hand-pick for an invite-only
	// workspace. The caller is an org admin/owner here, so emails are visible.
	const { data: orgMembers } = useQuery({
		enabled: Boolean(targetOrganisationId),
		queryFn: async (): Promise<OrgMemberRow[]> => {
			const res = await fetch(
				`${API_BASE_URL}/v2/orgs/${targetOrganisationId}/members`,
				{ credentials: "include" },
			);
			if (!res.ok) return [];
			const rows = await res.json();
			return Array.isArray(rows) ? rows : [];
		},
		queryKey: ["v2", "orgs", targetOrganisationId, "members"],
		staleTime: 60_000,
	});

	const memberOptions = useMemo(() => {
		const selfEmail = (meV2?.email ?? "").toLowerCase();
		return (orgMembers ?? [])
			.filter(
				(m) => !m.is_external && m.email && m.email.toLowerCase() !== selfEmail,
			)
			.map((m) => ({
				label: m.display_name ? `${m.display_name} (${m.email})` : m.email,
				value: m.email,
			}));
	}, [orgMembers, meV2]);

	const backDestination = targetOrganisationId
		? `/o/${targetOrganisationId}/overview`
		: "/o";

	const mutation = useMutation({
		mutationFn: async () => {
			if (!targetOrganisationId) {
				throw new Error(t`Choose an organisation first`);
			}
			const isClient = billFor === "client";
			const ws = await createWorkspace({
				inherit_organisation_admins: access === "everyone",
				name: name.trim(),
				org_id: targetOrganisationId,
				// Sending a data owner is what makes the workspace external/separate.
				...(isClient
					? {
							data_owner_email: dataOwnerEmail.trim(),
							data_owner_org_name: dataOwnerOrgName.trim(),
							partner_agreement_accepted: true,
						}
					: {}),
			});
			// Invite-only: add the hand-picked members now. The workspace already
			// exists, so a per-member failure is surfaced but never unwinds it.
			if (access === "invite" && memberEmails.length > 0) {
				let failed = 0;
				for (const email of memberEmails) {
					try {
						await addWorkspaceMember(ws.id, email);
					} catch {
						failed++;
					}
				}
				if (failed > 0) {
					toast.error(
						failed === 1
							? t`Couldn't add 1 member. Add them from workspace settings.`
							: t`Couldn't add ${failed} members. Add them from workspace settings.`,
					);
				}
			}
			return ws;
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: async (ws) => {
			posthog.capture("workspace_created", {
				bill_separately: billFor === "client",
				member_adds: access === "invite" ? memberEmails.length : 0,
				visibility: access === "everyone" ? "open_to_organisation" : "private",
			});
			toast.success(t`Workspace created.`);
			// useWorkspace's context list is keyed ["v2","workspaces-context",...],
			// not ["v2","workspaces"]; refresh both and pre-select so /w/<id>/home
			// resolves the new workspace instead of falling back to the default.
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] }),
				queryClient.invalidateQueries({
					queryKey: ["v2", "workspaces-context"],
				}),
			]);
			setWorkspace(ws.id);
			// A separately-billed (client) workspace lands on its billing tab to
			// subscribe; an org-billed one goes straight to the workspace.
			if (billFor === "client") {
				navigate(`/w/${ws.id}/settings/billing`);
			} else {
				navigate(`/w/${ws.id}/home`);
			}
		},
	});

	const handleCancel = () => {
		if (name.trim()) {
			modals.openConfirmModal({
				children: (
					<Text size="sm">
						<Trans>Your draft won't be saved.</Trans>
					</Text>
				),
				confirmProps: { color: "red" },
				labels: { cancel: t`Keep editing`, confirm: t`Discard` },
				onConfirm: () => navigate(backDestination),
				title: t`Discard this workspace?`,
			});
		} else {
			navigate(backDestination);
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
							Only organisation admins and owners can create workspaces. Ask an
							admin on your organisation to create one, or to promote you first.
						</Trans>
					</Text>
					<Group>
						<Button variant="outline" onClick={() => navigate(backDestination)}>
							<Trans>Back</Trans>
						</Button>
					</Group>
				</Stack>
			</Container>
		);
	}

	const accessOptions: {
		value: Access;
		title: string;
		description: string;
		icon: typeof Buildings;
	}[] = [
		{
			description: t`Everyone can find it. Admins join directly; members can ask.`,
			icon: Buildings,
			title: t`Everyone in your organisation`,
			value: "everyone",
		},
		{
			description: t`Only the people you add or invite can see it.`,
			icon: UsersThree,
			title: t`Invite only`,
			value: "invite",
		},
		{
			description: t`Only you can see this workspace.`,
			icon: Lock,
			title: t`Private, just me`,
			value: "just_me",
		},
	];

	const accessLabel =
		accessOptions.find((o) => o.value === access)?.title ?? "";

	const canAdvanceFromName = name.trim().length > 0;
	// External-client billing step (ISSUE-026): require a data owner email
	// before leaving the Billing step / submitting.
	const isClientWorkspace = billFor === "client";
	const dataOwnerValid = /.+@.+\..+/.test(dataOwnerEmail.trim());
	const ownerOrgValid = dataOwnerOrgName.trim().length > 0;
	const canAdvanceFromBilling =
		!isClientWorkspace || (ownerOrgValid && dataOwnerValid);
	const canSubmit =
		canAdvanceFromName &&
		canAdvanceFromBilling &&
		Boolean(targetOrganisationId);

	return (
		<Container size="xl" py="xl" px="lg">
			<Stack gap={28}>
				<Stack gap={6}>
					<Title order={3} fw={400}>
						<Trans>Create workspace</Trans>
					</Title>
					{targetOrganisation && (
						<Text size="sm" c="dimmed">
							<Trans>
								For <em>{targetOrganisation.name}</em>
							</Trans>
						</Text>
					)}
				</Stack>

				{organisationIdFromQuery && !targetOrganisation && (
					<Alert color="gray" variant="light">
						<Trans>
							You don't have permission to create workspaces in that
							organisation. Falling back to your primary organisation instead.
						</Trans>
					</Alert>
				)}

				<Stepper
					active={step}
					onStepClick={(i) => {
						if (i <= step) setStep(i);
					}}
					size="sm"
					iconSize={28}
				>
					<Stepper.Step label={t`Name`}>
						<Stack gap={16} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>Name your workspace.</Trans>
							</Text>
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
										label: o.name,
										value: o.id,
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

					<Stepper.Step label={t`Ownership`}>
						<Stack gap={14} mt="md">
							{
								<>
									<Text size="sm" c="dimmed">
										<Trans>
											Is this for your organisation's internal use, or for an
											external organisation?
										</Trans>
									</Text>
									<Radio.Group
										value={billFor}
										onChange={(v) => setBillFor(v as BillFor)}
									>
										<Stack gap={10} mt={8}>
											<Radio
												value="internal"
												label={
													<Stack gap={2}>
														<Text size="sm">
															<Trans>For internal use</Trans>
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>
																Billed under your organisation's plan, alongside
																your other workspaces.
															</Trans>
														</Text>
													</Stack>
												}
											/>
											<Radio
												value="client"
												label={
													<Stack gap={2}>
														<Text size="sm">
															<Trans>For an external organisation</Trans>
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>
																A separate data-ownership and billing context.
																It can be handed off to that organisation later
																with no data movement.
															</Trans>
														</Text>
													</Stack>
												}
											/>
										</Stack>
									</Radio.Group>

									{billFor === "client" && (
										<Stack gap={10} mt={4}>
											<TextInput
												required
												label={<Trans>Owning organisation</Trans>}
												description={
													<Trans>
														Which organisation owns this workspace's data? This
														sets the data and compliance context.
													</Trans>
												}
												placeholder="Acme Organisation"
												value={dataOwnerOrgName}
												onChange={(e) =>
													setDataOwnerOrgName(e.currentTarget.value)
												}
												data-testid="create-workspace-data-owner-org"
											/>
											<TextInput
												type="email"
												required
												label={<Trans>Data owner email</Trans>}
												description={
													<Trans>
														Their representative who owns this data. They are
														added as a free observer and emailed that they are
														the data owner, and become the handoff contact.
													</Trans>
												}
												placeholder="jane.doe@acme.org"
												value={dataOwnerEmail}
												onChange={(e) =>
													setDataOwnerEmail(e.currentTarget.value)
												}
												data-testid="create-workspace-data-owner"
											/>
										</Stack>
									)}
								</>
							}
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Access`}>
						<Stack gap={16} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>Set who can see and join.</Trans>
							</Text>
							<SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
								{accessOptions.map((opt) => {
									const Icon = opt.icon;
									const selected = access === opt.value;
									return (
										<UnstyledButton
											key={opt.value}
											onClick={() => setAccess(opt.value)}
											aria-pressed={selected}
										>
											<Paper
												withBorder
												p="md"
												radius="sm"
												h="100%"
												className="transition-colors hover:!border-primary-400"
												style={{
													background: selected
														? "rgba(65, 105, 225, 0.06)"
														: undefined,
													borderColor: selected ? "#4169e1" : undefined,
												}}
											>
												<Stack gap={6}>
													<Group gap={8} wrap="nowrap">
														<Icon size={18} />
														<Text size="sm" fw={500}>
															{opt.title}
														</Text>
													</Group>
													<Text size="xs" c="dimmed">
														{opt.description}
													</Text>
												</Stack>
											</Paper>
										</UnstyledButton>
									);
								})}
							</SimpleGrid>

							{access === "invite" && (
								<MultiSelect
									label={t`Add people from your organisation`}
									description={t`They'll be added as members. You can add more later.`}
									placeholder={
										memberOptions.length > 0
											? t`Search people`
											: t`No one else in this organisation yet`
									}
									data={memberOptions}
									value={memberEmails}
									onChange={setMemberEmails}
									searchable
									clearable
									disabled={memberOptions.length === 0}
									nothingFoundMessage={t`No matches`}
								/>
							)}

							<Text size="xs" c="dimmed">
								<Trans>You can change this later in workspace settings.</Trans>
							</Text>
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Review`}>
						<Stack gap={14} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>Review before creating.</Trans>
							</Text>
							<Paper withBorder p="md" radius="sm">
								<Stack gap={10}>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={90}>
											<Trans>Name</Trans>
										</Text>
										<Text size="sm" fw={500}>
											{name.trim() || t`(missing)`}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={90}>
											<Trans>Organisation</Trans>
										</Text>
										<Text size="sm">
											{targetOrganisation?.name || t`(unknown)`}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={90}>
											<Trans>Ownership</Trans>
										</Text>
										<Text size="sm">
											{billFor === "client" ? (
												<Trans>Separate (client)</Trans>
											) : (
												<Trans>Under your organisation</Trans>
											)}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={90}>
											<Trans>Access</Trans>
										</Text>
										<Text size="sm">{accessLabel}</Text>
									</Group>
									{access === "invite" && (
										<Group gap={12} align="baseline">
											<Text size="xs" c="dimmed" w={90}>
												<Trans>People</Trans>
											</Text>
											<Text size="sm">
												{memberEmails.length > 0 ? (
													<Trans>
														{memberEmails.length} added from your organisation
													</Trans>
												) : (
													<Trans>No one added yet</Trans>
												)}
											</Text>
										</Group>
									)}
								</Stack>
							</Paper>
						</Stack>
					</Stepper.Step>
				</Stepper>

				<Group justify="space-between" mt="sm">
					<Button
						variant="outline"
						size="md"
						px="xl"
						onClick={step === 0 ? handleCancel : () => setStep(step - 1)}
					>
						{step === 0 ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
					</Button>
					{step < 3 ? (
						<Button
							size="md"
							px="xl"
							disabled={
								(step === 0 && !canAdvanceFromName) ||
								(step === 1 && !canAdvanceFromBilling)
							}
							onClick={() => setStep(step + 1)}
						>
							<Trans>Next</Trans>
						</Button>
					) : (
						<Button
							size="md"
							px="xl"
							// isSuccess keeps the button locked through the async onSuccess
							// window (refetch + navigate) so it can't double-submit.
							loading={mutation.isPending || mutation.isSuccess}
							disabled={!canSubmit || mutation.isSuccess}
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
