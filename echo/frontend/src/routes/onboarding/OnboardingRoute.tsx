import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useMyInvites } from "@/hooks/useMyInvites";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";

async function completeOnboarding(orgName: string) {
	const response = await fetch(`${API_BASE_URL}/v2/onboarding/complete`, {
		body: JSON.stringify({ org_name: orgName }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.detail || "Something went wrong");
	}
	return response.json();
}

async function sendInvite(workspaceId: string, email: string) {
	const response = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, role: "member" }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to send invite");
	}
	return response.json();
}

export const OnboardingRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const user = useCurrentUser();
	const { data: meV2, isLoading: meLoading } = useV2Me();
	const { setWorkspace } = useWorkspace();

	// Invited users see a different flow — they're not creating a organisation,
	// they're joining one (or several). Pull the invite list so we can
	// show them which workspaces they're about to land in.
	const { data: pendingInvites } = useMyInvites({
		enabled: meV2?.has_pending_invites === true,
	});
	const displayName = (user.data as Record<string, string>)?.first_name || "";
	const hasInvites = meV2?.has_pending_invites === true;
	const inviteOrganisations = Array.from(
		new Set((pendingInvites ?? []).map((i) => i.org_name)),
	);
	// The designer's onboarding split (docs/workspaces/designer-return.html):
	// users with projects from before workspaces existed see the "migration"
	// copy; users with no legacy projects see the fresh-setup copy. hasInvites
	// takes precedence over both (they're here to join a organisation, not set one up).
	const isLegacyUser = meV2?.has_legacy_projects === true;
	const defaultOrgName = displayName ? `${displayName}'s Organisation` : "";

	const [orgName, setOrgName] = useState(defaultOrgName);
	const [inviteEmails, setInviteEmails] = useState<string[]>([""]);
	const [step, setStep] = useState<"loading" | "org" | "invite">("loading");
	const [workspaceId, setWorkspaceId] = useState<string | null>(null);
	const [sendingInvites, setSendingInvites] = useState(false);
	const [ready, setReady] = useState(false);

	// useCallback so the effect below can list goToWorkspaceHome as a dep
	// without re-firing on every render. workspaceId / navigate are the
	// real triggers — wrapping them via this callback satisfies the
	// exhaustive-deps lint without hiding an actual dependency.
	const goToWorkspaceHome = useCallback(() => {
		if (workspaceId) {
			navigate(`/w/${workspaceId}/home`);
		} else {
			navigate("/w");
		}
	}, [workspaceId, navigate]);

	useDocumentTitle(t`Set up your workspace | dembrane`);

	useEffect(() => {
		// Only run the "already onboarded → bounce" check while the page
		// is still in the loading gate. Otherwise this effect re-fires
		// after submit (when we invalidate ["v2","me"] in onSuccess) and
		// the freshly-true onboarding_completed flag punts the user
		// straight to workspace home, silently skipping the invite step.
		if (step !== "loading") return;
		if (meLoading) return;

		if (meV2?.onboarding_completed === true) {
			goToWorkspaceHome();
			return;
		}

		const timer = setTimeout(() => {
			setStep("org");
			requestAnimationFrame(() => setReady(true));
		}, 1200);

		return () => clearTimeout(timer);
	}, [meV2, meLoading, step, goToWorkspaceHome]);

	const onboardingMutation = useMutation({
		mutationFn: () => completeOnboarding(orgName.trim() || defaultOrgName),
		onError: (error: Error) => {
			toast.error(error.message || t`Something went wrong`);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			// Onboarding's auto-accept loop can fire personal notifications
			// at the new user — INVITE_PENDING_AT_CAP when their invite was
			// blocked by a full workspace. Without this invalidation the
			// bell polls every 60s, so the row only appears after a refresh
			// or page nav. Invalidate both the list and the unread badge so
			// the icon goes red immediately when there's something to act on.
			queryClient.invalidateQueries({ queryKey: ["v2", "notifications"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "notifications", "unread-count"],
			});
			// Pending invites query too — the dropdown / inbox uses this.
			queryClient.invalidateQueries({ queryKey: ["v2", "me", "invites"] });
			// Org-only invitees return workspace_id=""; only set the active workspace when there's a real id.
			if (data.workspace_id) {
				setWorkspaceId(data.workspace_id);
				setWorkspace(data.workspace_id);
			}

			// Invited users skip the invite step — they don't have a organisation to invite
			if (hasInvites) {
				goToWorkspaceHome();
				return;
			}

			setReady(false);
			setTimeout(() => {
				setStep("invite");
				requestAnimationFrame(() => setReady(true));
			}, 150);
		},
	});

	const handleSendInvites = async () => {
		if (!workspaceId) return;

		const validEmails = inviteEmails.filter((e) => e.trim() && e.includes("@"));

		if (validEmails.length === 0) {
			goToWorkspaceHome();
			return;
		}

		setSendingInvites(true);
		let sent = 0;
		for (const email of validEmails) {
			try {
				await sendInvite(workspaceId, email.trim());
				sent++;
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed";
				toast.error(`${email}: ${message}`);
			}
		}
		setSendingInvites(false);

		if (sent > 0) {
			toast.success(sent === 1 ? t`Invite sent` : t`${sent} invites sent`);
		}
		goToWorkspaceHome();
	};

	const addEmailField = () => setInviteEmails([...inviteEmails, ""]);

	const removeEmailField = (index: number) =>
		setInviteEmails(inviteEmails.filter((_, i) => i !== index));

	const updateEmail = (index: number, value: string) => {
		const updated = [...inviteEmails];
		updated[index] = value;
		setInviteEmails(updated);
	};

	// ── Loading ──
	if (step === "loading") {
		return (
			<div
				style={{
					alignItems: "center",
					background: "var(--app-background, #f6f4f1)",
					display: "flex",
					flexDirection: "column",
					gap: 16,
					justifyContent: "center",
					minHeight: "100dvh",
				}}
			>
				<Loader size="sm" color="gray" />
				<Text size="sm" c="dimmed">
					<Trans>Setting things up for you</Trans>
				</Text>
			</div>
		);
	}

	// ── Invite step ──
	if (step === "invite") {
		return (
			<div
				style={{
					alignItems: "center",
					background: "var(--app-background, #f6f4f1)",
					display: "flex",
					justifyContent: "center",
					minHeight: "100dvh",
					overflow: "hidden",
					padding: "40px 24px",
					position: "relative",
				}}
			>
				<GradientBlurs />
				<div
					style={{
						opacity: ready ? 1 : 0,
						position: "relative",
						transform: ready ? "translateY(0)" : "translateY(12px)",
						transition: "opacity 0.5s ease, transform 0.5s ease",
						width: "min(400px, 100%)",
					}}
				>
					<Stack gap={24}>
						<Stack gap={6}>
							<Title order={3} fw={500}>
								<Trans>Invite your organisation</Trans>
							</Title>
							<Text size="sm" c="dimmed" lh={1.6}>
								<Trans>
									Colleagues you invite can explore conversations, share
									insights, and build reports with you.
								</Trans>
							</Text>
						</Stack>

						<Stack gap={10}>
							{inviteEmails.map((email, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: row identity tracks position; emails are user-editable so value-based keys cause remount-on-keystroke (focus loss)
								<Group key={`invite-${index}`} gap={8} wrap="nowrap">
									<TextInput
										flex={1}
										placeholder={t`name@example.com`}
										size="sm"
										value={email}
										autoFocus={index === 0}
										onChange={(e) => updateEmail(index, e.currentTarget.value)}
									/>
									{inviteEmails.length > 1 && (
										<ActionIcon
											color="gray"
											size="sm"
											variant="subtle"
											onClick={() => removeEmailField(index)}
										>
											<IconX size={14} />
										</ActionIcon>
									)}
								</Group>
							))}
							<Box>
								<Button
									leftSection={<IconPlus size={14} />}
									size="sm"
									variant="subtle"
									onClick={addEmailField}
								>
									<Trans>Add another</Trans>
								</Button>
							</Box>
						</Stack>

						<Group gap={12}>
							<Button
								size="md"
								variant="outline"
								onClick={() => goToWorkspaceHome()}
							>
								<Trans>Skip</Trans>
							</Button>
							<Button
								flex={1}
								loading={sendingInvites}
								disabled={
									!inviteEmails.some((e) => e.trim() && e.includes("@"))
								}
								size="md"
								onClick={handleSendInvites}
							>
								<Trans>Send invites</Trans>
							</Button>
						</Group>
					</Stack>
				</div>
			</div>
		);
	}

	// ── Org name step ──
	return (
		<div
			style={{
				background: "var(--app-background, #f6f4f1)",
				display: "flex",
				flexDirection: "column",
				minHeight: "100dvh",
				overflow: "hidden",
				position: "relative",
			}}
		>
			<GradientBlurs />

			{/* Compact layout (2026-04-24): illustration removed, form
			    centered like /login. The previous full-bleed banner pushed
			    the form to the bottom of the viewport with a large dead
			    space between — users read it as "wait, is the form below
			    the fold?" */}
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flex: "1 1 auto",
					justifyContent: "center",
					padding: "24px",
					position: "relative",
				}}
			>
				<div
					style={{
						maxWidth: 400,
						opacity: ready ? 1 : 0,
						transform: ready ? "translateY(0)" : "translateY(12px)",
						transition: "opacity 0.5s ease 0.3s, transform 0.5s ease 0.3s",
						width: "100%",
					}}
				>
					<Stack gap={24}>
						<Stack gap={6}>
							<Title order={3} fw={400}>
								{hasInvites ? (
									displayName ? (
										<Trans>Welcome, {displayName}</Trans>
									) : (
										<Trans>Welcome to dembrane</Trans>
									)
								) : isLegacyUser && displayName ? (
									<Trans>Welcome back, {displayName}</Trans>
								) : displayName ? (
									<Trans>Welcome, {displayName}</Trans>
								) : (
									<Trans>Set up your organisation</Trans>
								)}
							</Title>
							<Text size="sm" c="dimmed" lh={1.6}>
								{hasInvites ? (
									inviteOrganisations.length === 1 ? (
										<Trans>
											You've been invited to join{" "}
											<em>{inviteOrganisations[0]}</em>. We'll take you there in
											a moment.
										</Trans>
									) : inviteOrganisations.length > 1 ? (
										<Trans>
											You've been invited to join {inviteOrganisations.length}{" "}
											organisations. We'll take you in once you continue.
										</Trans>
									) : (
										<Trans>
											Your organisation is waiting for you. Click continue to
											join.
										</Trans>
									)
								) : isLegacyUser ? (
									<Trans>
										We've added organisations so you can organize projects and
										share them with colleagues. Everything you had before is
										still here. We just need a name for your organisation.
									</Trans>
								) : (
									<Trans>
										Name your organisation to get started. You can invite
										members right after, or join other organisations later from
										settings.
									</Trans>
								)}
							</Text>
						</Stack>

						{/* Invited users don't create a organisation — they're joining
						    existing ones. Swap the "Organisation name" form for a single
						    Continue button so the copy ("Your organisation is waiting")
						    matches the action. The backend /onboarding/complete
						    call still runs; it just skips the personal-org
						    branch when has_pending_invites is true. */}
						{hasInvites ? (
							<Stack gap={12}>
								<Button
									fullWidth
									loading={onboardingMutation.isPending}
									size="lg"
									onClick={() => onboardingMutation.mutate()}
								>
									<Trans>Continue</Trans>
								</Button>
							</Stack>
						) : (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									onboardingMutation.mutate();
								}}
							>
								<Stack gap={16}>
									<TextInput
										autoFocus
										description={t`You can change this anytime in settings.`}
										label={t`Organisation name`}
										placeholder={
											defaultOrgName || t`Your organisation or company`
										}
										size="sm"
										value={orgName}
										onChange={(e) => setOrgName(e.currentTarget.value)}
									/>

									<Button
										fullWidth
										loading={onboardingMutation.isPending}
										size="lg"
										type="submit"
									>
										<Trans>Get started</Trans>
									</Button>

									{isLegacyUser && (
										<Text size="xs" c="dimmed" mt={4}>
											<Trans>
												You'll find all your projects waiting for you.
											</Trans>
										</Text>
									)}
								</Stack>
							</form>
						)}
					</Stack>
				</div>
			</div>
		</div>
	);
};

function GradientBlurs() {
	return (
		<>
			<div
				style={{
					background:
						"radial-gradient(circle, rgba(65,105,225,0.07) 0%, transparent 70%)",
					borderRadius: "50%",
					filter: "blur(60px)",
					height: 500,
					pointerEvents: "none",
					position: "absolute",
					right: "-5%",
					top: "-10%",
					width: 500,
				}}
			/>
			<div
				style={{
					background:
						"radial-gradient(circle, rgba(30,255,161,0.05) 0%, transparent 70%)",
					borderRadius: "50%",
					bottom: "0%",
					filter: "blur(60px)",
					height: 400,
					left: "-5%",
					pointerEvents: "none",
					position: "absolute",
					width: 400,
				}}
			/>
			<div
				style={{
					background:
						"radial-gradient(circle, rgba(255,194,255,0.04) 0%, transparent 70%)",
					borderRadius: "50%",
					filter: "blur(60px)",
					height: 350,
					left: "60%",
					pointerEvents: "none",
					position: "absolute",
					top: "40%",
					width: 350,
				}}
			/>
		</>
	);
}
