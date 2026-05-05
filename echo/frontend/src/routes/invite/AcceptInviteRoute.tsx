import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Button,
	Container,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useAuthenticated, useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useAcceptInviteByHash } from "@/hooks/useMyInvites";

/**
 * Email link target: /invite/accept?token=...&iss=...&ws=...&email=...&role=...
 *
 * Handles three states:
 * - Not authenticated → show context + "Sign up" / "Log in" buttons
 * - Authenticated, wrong email → show "this invite is for X, you're logged in as Y"
 * - Authenticated, matching email → show Accept / Decline buttons
 */
export const AcceptInviteRoute = () => {
	const [searchParams] = useSearchParams();
	const navigate = useI18nNavigate();
	const { isAuthenticated, loading: authLoading } = useAuthenticated();
	const { data: currentUser } = useCurrentUser({ enabled: isAuthenticated });
	const acceptMutation = useAcceptInviteByHash();
	const [result, setResult] = useState<"idle" | "accepted" | "error">("idle");
	const [errorMsg, setErrorMsg] = useState<string>("");
	// Status code from the last failed attempt. 402 = cap reached → render
	// in yellow with a retry path; anything else (404 / 410 expired / 500)
	// stays red. Avoids substring-matching the error copy, which would
	// silently switch tone on i18n or backend message changes.
	const [errorStatus, setErrorStatus] = useState<number | null>(null);

	const hash = searchParams.get("h") || "";
	const inviterName = searchParams.get("iss") || t`Someone`;
	const workspaceName = searchParams.get("ws") || t`a workspace`;
	const role = searchParams.get("role") || "member";
	// Email the invite was sent to. Carried in the URL so the registration
	// form can pre-fill + lock the field, preventing the "I typed
	// guest2@... by accident and now I have a stray personal org" trap.
	const invitedEmail = (searchParams.get("email") || "").toLowerCase();
	const myEmail = (currentUser?.email || "").toLowerCase();
	const emailMismatch =
		isAuthenticated && !!invitedEmail && !!myEmail && invitedEmail !== myEmail;

	useDocumentTitle(t`Join ${workspaceName} | dembrane`);

	// Preserve invite URL through login/register. Pass the invited email
	// as a separate query param so /register pre-fills the form.
	const currentUrl = window.location.pathname + window.location.search;
	const emailQs = invitedEmail
		? `&email=${encodeURIComponent(invitedEmail)}`
		: "";
	const loginUrl = `/login?next=${encodeURIComponent(currentUrl)}${emailQs}`;
	const registerUrl = `/register?next=${encodeURIComponent(currentUrl)}${emailQs}`;

	const handleAccept = async () => {
		if (!hash) {
			toast.error(t`Invalid invite link`);
			return;
		}
		try {
			const data = await acceptMutation.mutateAsync({
				claimedRole: role,
				hash,
			});
			setResult("accepted");
			toast.success(t`You're in`);
			setTimeout(() => {
				navigate(`/w/${data.workspace_id}/projects`);
			}, 1000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to accept";
			const status =
				err instanceof Error
					? ((err as Error & { status?: number }).status ?? null)
					: null;
			setErrorMsg(msg);
			setErrorStatus(status);
			setResult("error");
		}
	};

	if (authLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	return (
		<Container size="xs" py="xl" px="lg">
			<Stack gap={24} mt="10vh">
				<Paper p="xl" radius="md" withBorder>
					<Stack gap={20}>
						<Stack gap={6}>
							<Badge size="sm" variant="light" color="blue" w="fit-content">
								<Trans>Invitation</Trans>
							</Badge>
							<Title order={3} fw={400}>
								<Trans>
									{inviterName} invited you to join {workspaceName}
								</Trans>
							</Title>
						</Stack>

						<Text size="sm" c="dimmed" lh={1.5}>
							<Trans>
								Join this workspace to collaborate on conversations, share
								insights, and build reports together.
							</Trans>
						</Text>

						{/* Not logged in */}
						{!isAuthenticated && (
							<Stack gap={8}>
								<Button
									size="md"
									fullWidth
									onClick={() => navigate(registerUrl)}
								>
									<Trans>Create an account to join</Trans>
								</Button>
								<Button
									size="md"
									fullWidth
									variant="default"
									onClick={() => navigate(loginUrl)}
								>
									<Trans>Already have an account? Log in</Trans>
								</Button>
							</Stack>
						)}

						{/* Authenticated but with a different email than the invite
						    was sent to. The backend would 404 because the by-hash
						    accept iterates pending invites for the caller's email
						    and won't find one. Surface this clearly with a "log
						    out and sign up with the right address" affordance
						    instead of letting them click Accept and fail. */}
						{isAuthenticated && emailMismatch && (
							<Stack gap={8}>
								<Alert color="yellow" variant="light">
									<Stack gap={4}>
										<Text size="sm" fw={500}>
											<Trans>This invite isn't for this account</Trans>
										</Text>
										<Text size="xs">
											<Trans>
												The invite was sent to {invitedEmail}, but you're signed
												in as {myEmail}. Log out and sign up with the right
												address, or ask the admin to re-invite {myEmail}.
											</Trans>
										</Text>
									</Stack>
								</Alert>
								<Button
									size="md"
									fullWidth
									variant="default"
									onClick={() => navigate("/w")}
								>
									<Trans>Back to my workspaces</Trans>
								</Button>
							</Stack>
						)}

						{/* Logged in with the right email. Buttons stay rendered on
					    the error path so the user can retry without refreshing
					    — useful for the cap-reached case where the admin
					    freeing a seat between two clicks is the resolution. */}
						{isAuthenticated &&
							!emailMismatch &&
							(result === "idle" || result === "error") && (
								<Stack gap={8}>
									<Button
										size="md"
										fullWidth
										loading={acceptMutation.isPending}
										onClick={handleAccept}
									>
										{result === "error" ? (
											<Trans>Try again</Trans>
										) : (
											<Trans>Accept and join</Trans>
										)}
									</Button>
									<Button
										size="md"
										fullWidth
										variant="default"
										onClick={() => navigate("/w")}
									>
										<Trans>Not now</Trans>
									</Button>
								</Stack>
							)}

						{result === "accepted" && (
							<Alert color="green" variant="light">
								<Text size="sm">
									<Trans>Welcome to {workspaceName}. Taking you there…</Trans>
								</Text>
							</Alert>
						)}

						{result === "error" && (
							<Alert
								color={errorStatus === 402 ? "yellow" : "red"}
								variant="light"
							>
								<Stack gap={4}>
									<Text size="sm" fw={500}>
										<Trans>Couldn't join right now</Trans>
									</Text>
									<Text size="xs">{errorMsg}</Text>
									<Text size="xs" c="dimmed">
										<Trans>
											Your invite is still pending. Try again once the admin
											frees a seat or upgrades the workspace.
										</Trans>
									</Text>
								</Stack>
							</Alert>
						)}
					</Stack>
				</Paper>

				<Text size="xs" c="dimmed" ta="center">
					<Trans>Didn't expect this? You can safely ignore this page.</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
