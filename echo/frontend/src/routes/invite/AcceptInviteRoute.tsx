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
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
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
	const acceptMutation = useAcceptInviteByHash();
	const [result, setResult] = useState<"idle" | "accepted" | "error">("idle");
	const [errorMsg, setErrorMsg] = useState<string>("");

	const hash = searchParams.get("h") || "";
	const inviterName = searchParams.get("iss") || t`Someone`;
	const workspaceName = searchParams.get("ws") || t`a workspace`;
	const role = searchParams.get("role") || "member";

	useDocumentTitle(t`Join ${workspaceName} | dembrane`);

	// Preserve invite URL through login/register
	const currentUrl = window.location.pathname + window.location.search;
	const loginUrl = `/login?next=${encodeURIComponent(currentUrl)}`;
	const registerUrl = `/register?next=${encodeURIComponent(currentUrl)}`;

	const handleAccept = async () => {
		if (!hash) {
			toast.error(t`Invalid invite link`);
			return;
		}
		try {
			const data = await acceptMutation.mutateAsync({ hash, claimedRole: role });
			setResult("accepted");
			toast.success(t`You're in`);
			setTimeout(() => {
				navigate(`/w/${data.workspace_id}/projects`);
			}, 1000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to accept";
			setErrorMsg(msg);
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
								<Button size="md" fullWidth onClick={() => navigate(registerUrl)}>
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

						{/* Logged in */}
						{isAuthenticated && result === "idle" && (
							<Stack gap={8}>
								<Button
									size="md"
									fullWidth
									loading={acceptMutation.isPending}
									onClick={handleAccept}
								>
									<Trans>Accept and join</Trans>
								</Button>
								<Button
									size="md"
									fullWidth
									variant="default"
									onClick={() => navigate("/workspaces")}
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
							<Alert color="red" variant="light">
								<Text size="sm">{errorMsg}</Text>
							</Alert>
						)}
					</Stack>
				</Paper>

				<Text size="xs" c="dimmed" ta="center">
					<Trans>
						Didn't expect this? You can safely ignore this page.
					</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
