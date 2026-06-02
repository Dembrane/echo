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
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	useAcceptInviteByHash,
	useInviteByHash,
	usePublicInviteStatus,
} from "@/hooks/useMyInvites";

// Link: /invite/accept?h=...&iss=...&(ws|org)=...&email=...&role=...; hash is the lookup key, inspect-on-mount drives UI state.
export const AcceptInviteRoute = () => {
	const [searchParams] = useSearchParams();
	const navigate = useI18nNavigate();
	const { isAuthenticated, loading: authLoading } = useAuthenticated();
	const { data: currentUser } = useCurrentUser({ enabled: isAuthenticated });
	const acceptMutation = useAcceptInviteByHash();
	const logoutMutation = useLogoutMutation();
	const [errorMsg, setErrorMsg] = useState<string>("");
	// 402 = cap reached → yellow retry; anything else stays red.
	// Status-based instead of substring-matching the i18n'd copy.
	const [errorStatus, setErrorStatus] = useState<number | null>(null);

	const hash = searchParams.get("h") || "";
	const inviterName = searchParams.get("iss") || t`Someone`;
	const workspaceNameParam = searchParams.get("ws") || "";
	const orgNameParam = searchParams.get("org") || "";
	const subjectFromUrl =
		orgNameParam || workspaceNameParam || t`a workspace`;
	const role = searchParams.get("role") || "member";
	// Carried in URL so /register can pre-fill + lock the email field —
	// prevents stray personal-org signups from typo'd addresses.
	const invitedEmail = (searchParams.get("email") || "").toLowerCase();
	const myEmail = (currentUser?.email || "").toLowerCase();
	const emailMismatch =
		isAuthenticated && !!invitedEmail && !!myEmail && invitedEmail !== myEmail;

	// Authenticated inspect only fires when email matches; the other
	// branches render their own UI without hitting this endpoint.
	const canInspect = isAuthenticated && !!hash && !emailMismatch;
	const { data: inviteState, isLoading: inspectLoading } = useInviteByHash(
		hash,
		{ enabled: canInspect },
	);

	// Public probe gates the unauth path so a cancelled/expired hash
	// doesn't bounce visitors into register → stray personal org.
	const canProbePublic = !authLoading && !isAuthenticated && !!hash;
	const { data: publicInviteState, isLoading: publicInspectLoading } =
		usePublicInviteStatus(invitedEmail, hash, { enabled: canProbePublic });

	useDocumentTitle(t`Join ${subjectFromUrl} | dembrane`);

	// Preserve invite URL through login/register. Pass the invited email
	// as a separate query param so /register pre-fills the form.
	const currentUrl = window.location.pathname + window.location.search;
	const emailQs = invitedEmail
		? `&email=${encodeURIComponent(invitedEmail)}`
		: "";
	const loginUrl = `/login?next=${encodeURIComponent(currentUrl)}${emailQs}`;
	const registerUrl = `/register?next=${encodeURIComponent(currentUrl)}${emailQs}`;

	// Backend-authoritative name (handles renames); falls back to URL param while loading. Org-only invites use org_name instead of workspace_name.
	const resolvedWorkspaceName =
		inviteState?.workspace_name ||
		inviteState?.org_name ||
		publicInviteState?.workspace_name ||
		publicInviteState?.org_name ||
		subjectFromUrl;

	const handleAccept = async () => {
		if (!hash) {
			toast.error(t`Invalid invite link`);
			return;
		}
		setErrorMsg("");
		setErrorStatus(null);
		try {
			const data = await acceptMutation.mutateAsync({
				claimedRole: role,
				hash,
			});
			// already_member / healed shouldn't toast "Joined!" —
			// the user was already in.
			if (data.status === "success" || !data.status) {
				toast.success(t`You're in`);
			}
			setTimeout(() => {
				// Org-only acceptance lands on /w (WorkspaceSelectorRoute surfaces DiscoverableWorkspaces per-org).
				if (data.type === "org") {
					navigate("/w");
				} else if (data.workspace_id) {
					navigate(`/w/${data.workspace_id}/home`);
				} else {
					navigate("/w");
				}
			}, 800);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to accept";
			const status =
				err instanceof Error
					? ((err as Error & { status?: number }).status ?? null)
					: null;
			setErrorMsg(msg);
			setErrorStatus(status);
		}
	};

	const handleLogoutAndRetry = () => {
		// Drop the session; ?next= brings them back here after auth so
		// the inspect path agrees on email.
		logoutMutation.mutate({
			doRedirect: true,
			next: currentUrl,
		});
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
							<Badge size="sm" variant="light" color="primary" w="fit-content">
								<Trans>Invitation</Trans>
							</Badge>
							<Title order={3} fw={400}>
								<Trans>
									{inviterName} invited you to join {resolvedWorkspaceName}
								</Trans>
							</Title>
						</Stack>

						{/* Missing hash → can't identify the invite; copy stays
						    generic to avoid leaking link structure. */}
						{!hash && (
							<Alert color="red" variant="light">
								<Stack gap={4}>
									<Text size="sm" fw={500}>
										<Trans>This invite link isn't valid</Trans>
									</Text>
									<Text size="xs">
										<Trans>
											Open the original invitation email and click the link from
											there, or ask the inviter to send a new invite.
										</Trans>
									</Text>
								</Stack>
							</Alert>
						)}

						{/* Unauth path — register/login only show on `pending`,
						    so dead hashes can't fall through into signup. */}
						{hash && !isAuthenticated && (
							<>
								{publicInspectLoading && (
									<Stack align="center" py="md">
										<Loader size="sm" color="gray" />
									</Stack>
								)}

								{!publicInspectLoading &&
									publicInviteState?.status === "not_found" && (
										<Alert color="red" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>This invite is no longer valid</Trans>
												</Text>
												<Text size="xs">
													<Trans>
														The admin may have cancelled it, or the link was
														tampered with. Ask the inviter to send a new one.
													</Trans>
												</Text>
											</Stack>
										</Alert>
									)}

								{!publicInspectLoading &&
									publicInviteState?.status === "expired" && (
										<Alert color="yellow" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>This invite has expired</Trans>
												</Text>
												<Text size="xs">
													<Trans>
														Invites expire after 7 days. Ask {inviterName} to
														send a new one.
													</Trans>
												</Text>
											</Stack>
										</Alert>
									)}

								{!publicInspectLoading &&
									publicInviteState?.status === "workspace_deleted" && (
										<Alert color="red" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>This workspace no longer exists</Trans>
												</Text>
												<Text size="xs">
													<Trans>
														The workspace this invite was for has been deleted.
														There's nothing to join.
													</Trans>
												</Text>
											</Stack>
										</Alert>
									)}

								{!publicInspectLoading &&
									publicInviteState?.status === "org_deleted" && (
										<Alert color="red" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>This organisation no longer exists</Trans>
												</Text>
												<Text size="xs">
													<Trans>
														The organisation this invite was for has been
														deleted. There's nothing to join.
													</Trans>
												</Text>
											</Stack>
										</Alert>
									)}

								{/* Already accepted — offer login (registering would
								    duplicate an existing account). */}
								{!publicInspectLoading &&
									publicInviteState?.status === "accepted" && (
										<Stack gap={8}>
											<Alert color="primary" variant="light">
												<Stack gap={4}>
													<Text size="sm" fw={500}>
														<Trans>This invite has already been used</Trans>
													</Text>
													<Text size="xs">
														<Trans>
															Log in to {resolvedWorkspaceName} to continue.
														</Trans>
													</Text>
												</Stack>
											</Alert>
											<Button
												size="md"
												fullWidth
												onClick={() => navigate(loginUrl)}
											>
												<Trans>Log in</Trans>
											</Button>
										</Stack>
									)}

								{/* Pending — the actual landing. Also the fallback
								    when we can't probe (no email in URL). */}
								{!publicInspectLoading &&
									(publicInviteState?.status === "pending" ||
										!publicInviteState ||
										!invitedEmail) && (
										<>
											<Text size="sm" c="dimmed" lh={1.5}>
												{publicInviteState?.type === "org" ? (
													<Trans>
														Join this organisation to discover workspaces and
														collaborate with your team.
													</Trans>
												) : (
													<Trans>
														Join this workspace to collaborate on conversations,
														share insights, and build reports together.
													</Trans>
												)}
											</Text>
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
													variant="outline"
													onClick={() => navigate(loginUrl)}
												>
													<Trans>Already have an account? Log in</Trans>
												</Button>
											</Stack>
										</>
									)}
							</>
						)}

						{/* Email mismatch — accept would 404; offer logout + retry. */}
						{hash && isAuthenticated && emailMismatch && (
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
									loading={logoutMutation.isPending}
									onClick={handleLogoutAndRetry}
								>
									<Trans>Log out and use the invited email</Trans>
								</Button>
								<Button
									size="md"
									fullWidth
									variant="outline"
									onClick={() => navigate("/w")}
								>
									<Trans>Back to my workspaces</Trans>
								</Button>
							</Stack>
						)}

						{/* Auth + email match — inspect drives the rest. */}
						{hash && isAuthenticated && !emailMismatch && (
							<>
								{inspectLoading && (
									<Stack align="center" py="md">
										<Loader size="sm" color="gray" />
									</Stack>
								)}

								{!inspectLoading && inviteState?.status === "not_found" && (
									<Alert color="red" variant="light">
										<Stack gap={4}>
											<Text size="sm" fw={500}>
												<Trans>
													This invite link isn't valid for this account
												</Trans>
											</Text>
											<Text size="xs">
												<Trans>
													The link may have been removed, or it was sent to a
													different email address. Ask the inviter to send a new
													one.
												</Trans>
											</Text>
										</Stack>
									</Alert>
								)}

								{!inspectLoading && inviteState?.status === "expired" && (
									<Alert color="yellow" variant="light">
										<Stack gap={4}>
											<Text size="sm" fw={500}>
												<Trans>This invite has expired</Trans>
											</Text>
											<Text size="xs">
												<Trans>
													Invites expire after 7 days. Ask {inviterName} to send
													a new one.
												</Trans>
											</Text>
										</Stack>
									</Alert>
								)}

								{!inspectLoading &&
									inviteState?.status === "workspace_deleted" && (
										<Alert color="red" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>This workspace no longer exists</Trans>
												</Text>
												<Text size="xs">
													<Trans>
														The workspace this invite was for has been deleted.
														There's nothing to join.
													</Trans>
												</Text>
											</Stack>
										</Alert>
									)}

								{!inspectLoading && inviteState?.status === "org_deleted" && (
									<Alert color="red" variant="light">
										<Stack gap={4}>
											<Text size="sm" fw={500}>
												<Trans>This organisation no longer exists</Trans>
											</Text>
											<Text size="xs">
												<Trans>
													The organisation this invite was for has been deleted.
													There's nothing to join.
												</Trans>
											</Text>
										</Stack>
									</Alert>
								)}

								{/* Consumed. No "Accept and join" — jump-to-workspace
								    if they're a member, ask-admin if they're not. */}
								{!inspectLoading && inviteState?.status === "accepted" && (
									<Stack gap={8}>
										<Alert color="primary" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>This invite has already been used</Trans>
												</Text>
												{inviteState.is_member ? (
													<Text size="xs">
														<Trans>
															You're already a member of {resolvedWorkspaceName}
															.
														</Trans>
													</Text>
												) : (
													<Text size="xs">
														<Trans>
															Your invite was already accepted, but you're no
															longer a member of {resolvedWorkspaceName}. Ask
															the admin to re-invite you.
														</Trans>
													</Text>
												)}
											</Stack>
										</Alert>
										{inviteState.is_member &&
											(inviteState.type === "org"
												? inviteState.org_id
												: inviteState.workspace_id) && (
												<Button
													size="md"
													fullWidth
													onClick={() =>
														navigate(
															inviteState.type === "org"
																? "/w"
																: `/w/${inviteState.workspace_id}/home`,
														)
													}
												>
													<Trans>Take me to {resolvedWorkspaceName}</Trans>
												</Button>
											)}
										<Button
											size="md"
											fullWidth
											variant="outline"
											onClick={() => navigate("/w")}
										>
											<Trans>Back to my workspaces</Trans>
										</Button>
									</Stack>
								)}

								{/* Defensive — pending row but membership already exists. */}
								{!inspectLoading &&
									inviteState?.status === "pending" &&
									inviteState.is_member && (
										<Stack gap={8}>
											<Alert color="primary" variant="light">
												<Text size="sm">
													<Trans>
														You're already in {resolvedWorkspaceName}.
													</Trans>
												</Text>
											</Alert>
											{(inviteState.type === "org"
												? inviteState.org_id
												: inviteState.workspace_id) && (
												<Button
													size="md"
													fullWidth
													onClick={() =>
														navigate(
															inviteState.type === "org"
																? "/w"
																: `/w/${inviteState.workspace_id}/home`,
														)
													}
												>
													<Trans>Take me to {resolvedWorkspaceName}</Trans>
												</Button>
											)}
										</Stack>
									)}

								{/* Pending + non-member — the only path that shows
								    Accept. Buttons stay on error so retry works
								    once the admin frees a seat. */}
								{!inspectLoading &&
									inviteState?.status === "pending" &&
									!inviteState.is_member && (
										<>
											<Text size="sm" c="dimmed" lh={1.5}>
												{inviteState.type === "org" ? (
													<Trans>
														Join this organisation to discover workspaces and
														collaborate with your team.
													</Trans>
												) : (
													<Trans>
														Join this workspace to collaborate on conversations,
														share insights, and build reports together.
													</Trans>
												)}
											</Text>
											<Stack gap={8}>
												<Button
													size="md"
													fullWidth
													loading={acceptMutation.isPending}
													onClick={handleAccept}
												>
													{errorMsg ? (
														<Trans>Try again</Trans>
													) : (
														<Trans>Accept and join</Trans>
													)}
												</Button>
												<Button
													size="md"
													fullWidth
													variant="outline"
													onClick={() => navigate("/w")}
												>
													<Trans>Not now</Trans>
												</Button>
											</Stack>

											{errorMsg && (
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
																Your invite is still pending. Try again once the
																admin frees a seat or upgrades the workspace.
															</Trans>
														</Text>
													</Stack>
												</Alert>
											)}
										</>
									)}
							</>
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
