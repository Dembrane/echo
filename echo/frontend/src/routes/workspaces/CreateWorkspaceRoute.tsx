import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	Group,
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
import posthog from "posthog-js";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";

interface CreatedWorkspace {
	id: string;
	name: string;
}

async function createWorkspace(payload: {
	name: string;
	org_id: string;
	inherit_organisation_admins: boolean;
	bill_separately: boolean;
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

type Privacy = "open" | "private";
type BillFor = "internal" | "client";

/**
 * Self-serve workspace creation.
 *
 * Steps: Name → Billing → Access → Review. Org admins/owners create directly
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
	const [searchParams] = useSearchParams();
	const organisationIdFromQuery = searchParams.get("organisationId") ?? null;
	const { data: meV2, isLoading: meLoading } = useV2Me();

	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [privacy, setPrivacy] = useState<Privacy>("open");
	const [billFor, setBillFor] = useState<BillFor>("internal");

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
	const isPartner = Boolean(targetOrganisation?.is_partner);

	const backDestination = targetOrganisationId
		? `/o/${targetOrganisationId}/overview`
		: "/o";

	const mutation = useMutation({
		mutationFn: () => {
			if (!targetOrganisationId) {
				throw new Error(t`Choose an organisation first`);
			}
			return createWorkspace({
				bill_separately: isPartner && billFor === "client",
				inherit_organisation_admins: privacy === "open",
				name: name.trim(),
				org_id: targetOrganisationId,
			});
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: (ws) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			posthog.capture("workspace_created", {
				bill_separately: isPartner && billFor === "client",
				visibility: privacy === "open" ? "open_to_organisation" : "private",
			});
			toast.success(t`Workspace created.`);
			// A separately-billed (client) workspace lands on its billing tab to
			// subscribe; an org-billed one goes straight to the workspace.
			if (isPartner && billFor === "client") {
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

	const canAdvanceFromName = name.trim().length > 0;
	const canSubmit = canAdvanceFromName && Boolean(targetOrganisationId);

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

					<Stepper.Step label={t`Billing`}>
						<Stack gap={14} mt="md">
							{isPartner ? (
								<>
									<Text size="sm" c="dimmed">
										<Trans>Is this for internal use, or for another client?</Trans>
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
															<Trans>For another client</Trans>
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>
																A separate subscription, per the partner agreement,
																so it can be handed off to the client later with
																no data movement. You'll subscribe it next.
															</Trans>
														</Text>
													</Stack>
												}
											/>
										</Stack>
									</Radio.Group>
								</>
							) : (
								<Paper withBorder p="md" radius="sm">
									<Text size="sm">
										<Trans>Billed under your organisation</Trans>
									</Text>
									<Text size="xs" c="dimmed" mt={4}>
										<Trans>
											This workspace joins your organisation's plan. Manage the
											plan and seats from the organisation's billing.
										</Trans>
									</Text>
								</Paper>
							)}
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Access`}>
						<Stack gap={14} mt="md">
							<Text size="sm" c="dimmed">
								<Trans>Set who can see and join.</Trans>
							</Text>
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
														Everyone on your organisation can find it. Admins can
														join directly; members can ask to join.
													</Trans>
												</Text>
											</Stack>
										}
									/>
									<Radio
										value="private"
										label={
											<Stack gap={2}>
												<Text size="sm">
													<Trans>Private</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Only people you invite can see this workspace.
													</Trans>
												</Text>
											</Stack>
										}
									/>
								</Stack>
							</Radio.Group>
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
											<Trans>Billing</Trans>
										</Text>
										<Text size="sm">
											{isPartner && billFor === "client" ? (
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
										<Text size="sm">
											{privacy === "open" ? (
												<Trans>Open to the organisation</Trans>
											) : (
												<Trans>Private</Trans>
											)}
										</Text>
									</Group>
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
							disabled={step === 0 && !canAdvanceFromName}
							onClick={() => setStep(step + 1)}
						>
							<Trans>Next</Trans>
						</Button>
					) : (
						<Button
							size="md"
							px="xl"
							loading={mutation.isPending}
							disabled={!canSubmit}
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
