import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Checkbox,
	Group,
	Loader,
	Radio,
	Stack,
	Stepper,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconArrowLeft } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { InviteEmailList } from "@/components/organisation/InviteEmailList";
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
		new Set(
			(pendingInvites ?? [])
				.map((i) => i.org_name?.trim())
				.filter((name): name is string => Boolean(name)),
		),
	);
	// The designer's onboarding split (docs/workspaces/designer-return.html):
	// users with projects from before workspaces existed see the "migration"
	// copy; users with no legacy projects see the fresh-setup copy. hasInvites
	// takes precedence over both (they're here to join a organisation, not set one up).
	const isLegacyUser = meV2?.has_legacy_projects === true;
	const defaultOrgName = displayName ? `${displayName}'s Organisation` : "";

	const [orgName, setOrgName] = useState(defaultOrgName);
	const [inviteEmails, setInviteEmails] = useState<string[]>([""]);
	const [step, setStep] = useState<"loading" | "org" | "invite" | "questions">(
		"loading",
	);
	const [workspaceId, setWorkspaceId] = useState<string | null>(null);
	const [sendingInvites, setSendingInvites] = useState(false);
	const [ready, setReady] = useState(false);
	// ISSUE-012 questionnaire. Required but non-blocking — the user can skip
	// and still reach /o. q1 is select-many; q2/q3 are yes/no.
	const [q1, setQ1] = useState<string[]>([]);
	const [q2, setQ2] = useState<string | null>(null);
	const [q3, setQ3] = useState<string | null>(null);
	// Step 3 asks one question at a time. The training question (q3) only
	// appears when the high-risk answer (q2) is "yes", so the ordered list of
	// sub-questions is derived from q2. qSubStep indexes into it.
	const [qSubStep, setQSubStep] = useState(0);
	const questionFlow =
		q2 === "yes" ? ["risk", "training", "usage"] : ["risk", "usage"];
	const [submittingAnswers, setSubmittingAnswers] = useState(false);
	// Skip the questions step if the user already answered (re-onboarding).
	const alreadyAnswered = Boolean(meV2?.onboarding_answer_json);

	// Visible progress for the flow. Invited users skip the invite step
	// (they're joining, not building a organisation), so their stepper is
	// shorter. The stepper is a progress indicator only, not clickable: the
	// org-creation mutation has side effects, so we don't let users jump back.
	const flowSteps = hasInvites
		? [t`Welcome`, t`About you`]
		: [t`Organisation`, t`Invite`, t`About you`];
	const activeStep = hasInvites
		? step === "questions"
			? 1
			: 0
		: step === "invite"
			? 1
			: step === "questions"
				? 2
				: 0;

	// Everyone lands on the general home /o after onboarding (ISSUE-015 /
	// Founder decision D3) — not a specific workspace. useCallback keeps the
	// effect dep stable.
	const goToHome = useCallback(() => {
		navigate("/o");
	}, [navigate]);

	// Advance to the questionnaire, or skip straight to /o when the user has
	// already answered it.
	const goToQuestionsOrHome = useCallback(() => {
		if (alreadyAnswered) {
			goToHome();
			return;
		}
		setReady(false);
		setTimeout(() => {
			setStep("questions");
			requestAnimationFrame(() => setReady(true));
		}, 150);
	}, [alreadyAnswered, goToHome]);

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
			// Onboarded already. If they never answered the questionnaire
			// (ISSUE-012, required but non-blocking), nudge them through it;
			// otherwise straight to /o.
			if (meV2?.onboarding_answer_json) {
				goToHome();
			} else {
				setStep("questions");
				requestAnimationFrame(() => setReady(true));
			}
			return;
		}

		const timer = setTimeout(() => {
			setStep("org");
			requestAnimationFrame(() => setReady(true));
		}, 1200);

		return () => clearTimeout(timer);
	}, [meV2, meLoading, step, goToHome]);

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

			// Invited users skip the invite step — they don't have a organisation
			// to invite. They still see the questionnaire (unless answered).
			if (hasInvites) {
				goToQuestionsOrHome();
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
			goToQuestionsOrHome();
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
		goToQuestionsOrHome();
	};

	// ISSUE-012: persist the questionnaire answers, then route to /o. Required
	// but non-blocking — on a skip we still route on, and a submit failure
	// must not trap the user on this screen.
	const submitAnswers = async (skip: boolean) => {
		if (!skip) {
			setSubmittingAnswers(true);
			try {
				await fetch(`${API_BASE_URL}/v2/onboarding/answers`, {
					body: JSON.stringify({
						data: [{ q1 }, { q2: q2 ?? "" }, { q3: q3 ?? "" }],
						version: "17-jun-26",
					}),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				});
				queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			} catch {
				// Non-blocking: never trap the user. They reach /o regardless.
			} finally {
				setSubmittingAnswers(false);
			}
		}
		goToHome();
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
						<FlowStepper steps={flowSteps} active={activeStep} />
						<Stack gap={6}>
							<Title order={3} fw={500}>
								<Trans>Invite your team</Trans>
							</Title>
							<Text size="sm" c="dimmed" lh={1.6}>
								<Trans>
									Colleagues you invite can explore conversations, share
									insights, and build reports with you.
								</Trans>
							</Text>
						</Stack>

						<InviteEmailList
							emails={inviteEmails}
							onChange={setInviteEmails}
							autoFocusFirst
						/>

						<Group gap={12}>
							<Button
								size="md"
								variant="outline"
								onClick={() => goToQuestionsOrHome()}
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

	// ── Questions step (ISSUE-012) ──
	if (step === "questions") {
		const currentQ = questionFlow[Math.min(qSubStep, questionFlow.length - 1)];
		const isLastQ = qSubStep >= questionFlow.length - 1;
		const canContinue =
			currentQ === "risk"
				? q2 !== null
				: currentQ === "training"
					? q3 !== null
					: q1.length > 0;

		const goNext = () => {
			if (isLastQ) {
				submitAnswers(false);
				return;
			}
			setQSubStep((i) => i + 1);
		};
		const goBack = () => {
			if (qSubStep > 0) {
				setQSubStep((i) => i - 1);
				return;
			}
			// First question: step back to the previous onboarding screen
			// (invite for a new organisation, the welcome screen for invitees).
			setReady(false);
			setTimeout(() => {
				setStep(hasInvites ? "org" : "invite");
				requestAnimationFrame(() => setReady(true));
			}, 150);
		};

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
						width: "min(440px, 100%)",
					}}
				>
					<Stack gap={28}>
						<Button
							variant="subtle"
							size="sm"
							leftSection={<IconArrowLeft size={16} />}
							onClick={goBack}
							px={4}
							style={{ alignSelf: "flex-start" }}
						>
							<Trans>Back</Trans>
						</Button>

						<FlowStepper steps={flowSteps} active={activeStep} />

						{/* A reassuring title so users who land here unexpectedly
						    (e.g. existing users nudged through the questionnaire)
						    aren't surprised. */}
						<Stack gap={4}>
							<Title order={3} fw={500}>
								<Trans>Almost ready</Trans>
							</Title>
							<Text size="sm" lh={1.5}>
								<Trans>A couple of quick questions and you're in.</Trans>
							</Text>
						</Stack>

						{currentQ === "risk" && (
							<Stack key="risk" gap={12}>
								<Text size="md" fw={500} lh={1.4}>
									{t`Do you plan to use dembrane in health, education, recruitment, critical infrastructure management, law enforcement or justice contexts?`}
								</Text>
								<Radio.Group
									value={q2}
									onChange={(v) => {
										setQ2(v);
										// Dropping out of high-risk hides the training question,
										// so clear any stale answer to it.
										if (v === "no") setQ3(null);
									}}
								>
									<Group gap={16}>
										<Radio size="md" value="yes" label={t`Yes`} />
										<Radio size="md" value="no" label={t`No`} />
									</Group>
								</Radio.Group>
							</Stack>
						)}

						{currentQ === "training" && (
							<Stack key="training" gap={12}>
								<Text size="md" fw={500} lh={1.4}>
									{t`Have you completed a training?`}
								</Text>
								<Radio.Group value={q3} onChange={setQ3}>
									<Group gap={16}>
										<Radio size="md" value="yes" label={t`Yes`} />
										<Radio size="md" value="no" label={t`No`} />
									</Group>
								</Radio.Group>
							</Stack>
						)}

						{currentQ === "usage" && (
							<Stack key="usage" gap={12}>
								<Text size="md" fw={500} lh={1.4}>
									{t`What do you plan to use dembrane for?`}
								</Text>
								<Checkbox.Group value={q1} onChange={setQ1}>
									<Stack gap={10}>
										<Checkbox
											size="md"
											value="within my organisation"
											label={t`Within my organisation`}
										/>
										<Checkbox
											size="md"
											value="with external clients"
											label={t`With external clients`}
										/>
									</Stack>
								</Checkbox.Group>
							</Stack>
						)}

						<Group gap={12}>
							<Button
								size="md"
								variant="subtle"
								onClick={() => submitAnswers(true)}
							>
								<Trans>Skip</Trans>
							</Button>
							<Button
								flex={1}
								size="md"
								loading={submittingAnswers}
								disabled={!canContinue}
								onClick={goNext}
							>
								{isLastQ ? <Trans>Done</Trans> : <Trans>Continue</Trans>}
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
						<FlowStepper steps={flowSteps} active={activeStep} />
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
							<Text size="sm" lh={1.6}>
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

function FlowStepper({ steps, active }: { steps: string[]; active: number }) {
	return (
		<Stepper active={active} size="sm" iconSize={28} mb={8}>
			{steps.map((label) => (
				<Stepper.Step key={label} label={label} />
			))}
		</Stepper>
	);
}

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
