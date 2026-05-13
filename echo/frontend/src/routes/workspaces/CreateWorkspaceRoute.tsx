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
	Textarea,
	TextInput,
	ThemeIcon,
	Title,
} from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { TIER_CAPACITY_SHORT, type Tier } from "@/lib/tiers";

const REQUESTABLE_TIERS: Tier[] = ["pilot", "pioneer", "innovator", "changemaker", "guardian"];

async function submitWorkspaceRequest(payload: {
	kind: "new_workspace";
	org_id: string;
	proposed_name: string;
	proposed_tier: string;
	proposed_visibility: string;
	requester_message?: string;
}) {
	const res = await fetch(`${API_BASE_URL}/v2/workspace-requests`, {
		body: JSON.stringify(payload),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to submit request");
	}
	return res.json();
}

type Privacy = "open" | "private";

/**
 * Workspace request wizard — matrix §6 Slack-style model.
 *
 * Four steps: Name → Tier → Access → Review. Back + cancel on each.
 *
 * The final button submits a workspace request (not a direct create).
 * Staff review at /admin/upgrades; the user sees a confirmation panel.
 *
 * Tier picker shows paid tiers only (pilot through guardian); innovator
 * is the default. Free is never offered.
 *
 * Entry: `/w/new?organisationId=<org>`. Without organisationId, falls back to the
 * caller's primary admin organisation (with a quiet notice).
 */
export const CreateWorkspaceRoute = () => {
	const navigate = useI18nNavigate();
	const [searchParams] = useSearchParams();
	const organisationIdFromQuery = searchParams.get("organisationId") ?? null;
	const { data: meV2, isLoading: meLoading } = useV2Me();

	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [selectedTier, setSelectedTier] = useState<Tier>("innovator");
	const [privacy, setPrivacy] = useState<Privacy>("open");
	const [message, setMessage] = useState("");
	const [submitted, setSubmitted] = useState(false);

	useDocumentTitle(t`Request workspace | dembrane`);

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

	const canPickPrivate = selectedTier !== "free" && selectedTier !== "pilot" && selectedTier !== "pioneer";

	useEffect(() => {
		if (!canPickPrivate && privacy === "private") {
			setPrivacy("open");
		}
	}, [canPickPrivate, privacy]);

	const mutation = useMutation({
		mutationFn: () =>
			submitWorkspaceRequest({
				kind: "new_workspace",
				org_id: targetOrganisationId!,
				proposed_name: name.trim(),
				proposed_tier: selectedTier,
				proposed_visibility: privacy === "open" ? "open_to_organisation" : "private",
				requester_message: message.trim() || undefined,
			}),
		onSuccess: () => {
			setSubmitted(true);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleCancel = () => {
		if (name.trim()) {
			modals.openConfirmModal({
				title: t`Discard this request?`,
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
						<Trans>You can't request a workspace yet</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							Only organisation admins and owners can request workspaces. Ask an admin
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

	if (submitted) {
		return (
			<Container size="xs" py="xl" px="lg">
				<Stack gap="lg" align="center" ta="center">
					<ThemeIcon size="xl" radius="xl" color="green" variant="light">
						<IconCheck size={24} />
					</ThemeIcon>
					<Title order={3} fw={400}>
						<Trans>Request submitted</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							We'll be in touch within 1 business day.
						</Trans>
					</Text>
					<Button variant="default" onClick={() => navigate("/w")}>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Stack>
			</Container>
		);
	}

	const canAdvanceFromName = name.trim().length > 0;
	const canSubmit = canAdvanceFromName && Boolean(targetOrganisationId);

	return (
		<Container size="sm" py="xl" px="lg">
			<Stack gap={28}>
				<Stack gap={6}>
					<Title order={3} fw={400}>
						<Trans>Request workspace</Trans>
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
							You don't have permission to create workspaces in that organisation.
							Falling back to your primary organisation instead.
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
							<Radio.Group
								label={t`Choose a tier`}
								description={t`Each tier includes different limits. You can request an upgrade later.`}
								value={selectedTier}
								onChange={(v) => setSelectedTier(v as Tier)}
							>
								<Stack gap={10} mt={8}>
									{REQUESTABLE_TIERS.map((tier) => (
										<Radio
											key={tier}
											value={tier}
											label={
												<Stack gap={2}>
													<Text size="sm" tt="capitalize">
														{tier}
													</Text>
													<Text size="xs" c="dimmed">
														{TIER_CAPACITY_SHORT[tier]}
													</Text>
												</Stack>
											}
										/>
									))}
								</Stack>
							</Radio.Group>
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
										disabled={!canPickPrivate}
										label={
											<Stack gap={2}>
												<Text size="sm" c={canPickPrivate ? undefined : "dimmed"}>
													<Trans>Private</Trans>
													{!canPickPrivate && (
														<Text span size="xs" c="dimmed">
															{" "}(<Trans>requires Innovator or higher</Trans>)
														</Text>
													)}
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
										<Text size="sm" tt="capitalize">
											{selectedTier}
											<Text span c="dimmed" size="xs">
												{" · "}
												{TIER_CAPACITY_SHORT[selectedTier]}
											</Text>
										</Text>
									</Group>
								</Stack>
							</Paper>

							<Textarea
								label={t`Message (optional)`}
								description={t`Anything we should know? Discount requests, timelines, context.`}
								placeholder={t`e.g. We're a non-profit and would appreciate a discount.`}
								value={message}
								onChange={(e) => setMessage(e.currentTarget.value)}
								maxLength={1000}
								autosize
								minRows={2}
								maxRows={5}
							/>
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
							disabled={!canSubmit}
							onClick={() => mutation.mutate()}
						>
							<Trans>Request workspace</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</Container>
	);
};
