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
import { useEffect, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";

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
			body: JSON.stringify({ email, is_org_member: true, role: "member" }),
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

	const displayName = (user.data as Record<string, string>)?.first_name || "";
	const defaultOrgName = displayName ? `${displayName}'s Team` : "";

	const [orgName, setOrgName] = useState(defaultOrgName);
	const [inviteEmails, setInviteEmails] = useState<string[]>([""]);
	const [step, setStep] = useState<"loading" | "org" | "invite">("loading");
	const [workspaceId, setWorkspaceId] = useState<string | null>(null);
	const [sendingInvites, setSendingInvites] = useState(false);
	const [ready, setReady] = useState(false);

	useDocumentTitle(t`Set up your workspace | dembrane`);

	useEffect(() => {
		if (meLoading) return;

		if (meV2?.onboarding_completed === true) {
			navigate("/projects");
			return;
		}

		const timer = setTimeout(() => {
			setStep("org");
			requestAnimationFrame(() => setReady(true));
		}, 1200);

		return () => clearTimeout(timer);
	}, [meV2, meLoading, navigate]);

	const onboardingMutation = useMutation({
		mutationFn: () => completeOnboarding(orgName.trim() || defaultOrgName),
		onError: (error: Error) => {
			toast.error(error.message || t`Something went wrong`);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			setWorkspaceId(data.workspace_id);
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
			navigate("/projects");
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
		navigate("/projects");
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
								<Trans>Invite your team</Trans>
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
								<Group key={`invite-${email || index}`} gap={8} wrap="nowrap">
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
									color="gray"
									leftSection={<IconPlus size={14} />}
									px={0}
									size="xs"
									variant="subtle"
									onClick={addEmailField}
								>
									<Trans>Add another</Trans>
								</Button>
							</Box>
						</Stack>

						<Group gap={12}>
							<Button
								size="sm"
								variant="default"
								onClick={() => navigate("/projects")}
							>
								<Trans>Skip</Trans>
							</Button>
							<Button
								flex={1}
								loading={sendingInvites}
								size="sm"
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

			{/* Top: illustration as atmospheric hero */}
			<div
				style={{
					alignItems: "flex-end",
					display: "flex",
					flex: "0 0 auto",
					justifyContent: "center",
						opacity: ready ? 1 : 0,
					overflow: "hidden",
					paddingTop: 0,
					position: "relative",
					transform: ready ? "translateY(0)" : "translateY(-8px)",
					transition: "opacity 0.8s ease, transform 0.8s ease",
				}}
			>
				<img
					alt=""
					src="/illustrations/onboarding-banner.png"
					style={{
						height: "auto",
						pointerEvents: "none",
						userSelect: "none",
						width: "min(520px, 85vw)",
					}}
				/>
			</div>

			{/* Bottom: form, centered */}
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flex: "1 1 auto",
					justifyContent: "center",
					padding: "0 24px 48px",
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
							<Title order={3} fw={500}>
								{displayName ? (
									<Trans>
										{displayName}, your projects just got a new home
									</Trans>
								) : (
									<Trans>Your projects just got a new home</Trans>
								)}
							</Title>
							<Text size="sm" c="dimmed" lh={1.6}>
								<Trans>
									Everything is right where you left it. Now, with teams and
									workspaces, you can also invite your colleagues, share reports
									across projects, and organize work into dedicated spaces.
								</Trans>
							</Text>
						</Stack>

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
									label={t`Team name`}
									placeholder={defaultOrgName || t`Your team or company`}
									size="sm"
									value={orgName}
									onChange={(e) => setOrgName(e.currentTarget.value)}
								/>

								<Group gap={12}>
									<Button
										size="sm"
										variant="default"
										onClick={() => {
											completeOnboarding(defaultOrgName || "My Team")
												.then(() => {
													queryClient.invalidateQueries({
														queryKey: ["v2", "me"],
													});
													navigate("/projects");
												})
												.catch(() => navigate("/projects"));
										}}
									>
										<Trans>Use default</Trans>
									</Button>
									<Button
										flex={1}
										loading={onboardingMutation.isPending}
										size="sm"
										type="submit"
									>
										<Trans>Get started</Trans>
									</Button>
								</Group>

								<Text size="xs" c="dimmed" mt={4}>
									<Trans>
										You'll find all your projects waiting for you.
									</Trans>
								</Text>
							</Stack>
						</form>
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
