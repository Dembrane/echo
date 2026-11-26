import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Box,
	Button,
	Group,
	Paper,
	PinInput,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { SignedInElsewhere } from "@/components/auth/SignedInElsewhere";
import { useResendCooldown } from "@/components/auth/useResendCooldown";
import {
	authErrorCode,
	describeAuthError,
} from "@/components/auth/utils/errorUtils";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { I18nLink } from "@/components/common/i18nLink";
import { Logo } from "@/components/common/Logo";
import { Protected } from "@/components/common/Protected";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { resetSupportRequestSeen } from "@/components/workspace/supportRequestPromptState";
import { LEGAL_PRIVACY_URL } from "@/config";
import { resetPromptSeen } from "@/features/accounts/help/tasksPromptState";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import {
	type OtherDevice,
	otherSessions,
	replaceOtherDevice,
	sendSignInCode,
	signInWithCode,
	signOut,
} from "@/lib/auth";
import { emitAuthCacheBoundary } from "@/lib/authCacheBoundary";
import { AccountsApiError, call, type ResponseOf } from "../api/client";
import { DpaHint } from "../DpaHint";
import { AccountsI18n } from "../i18n";
import { SignRoute } from "./SignRoute";
import { LogInButton, logInPath, signPath as signPathOf } from "./signInLink";
import { clearAllDrafts } from "./signingDraft";

type Invite = ResponseOf<"signerInvite">;

/**
 * The door to signing. A signing link from an invitation (`?invite=`) opens a page made for
 * the person it was sent to: who asked, for which document, their name and address filled
 * in, and a code to their inbox instead of a password. Someone new gets an account that
 * reaches only what they were asked to sign; nothing asks them to set up a workspace. A
 * person signed in under another address is stopped before the document, never dropped into
 * someone else's signing. Without a token it is the plain sign route behind sign-in.
 */
export const SignGate = () => (
	<AccountsI18n signing>
		<Gate />
	</AccountsI18n>
);

const Gate = () => {
	const [searchParams] = useSearchParams();
	const invite = searchParams.get("invite");
	const { loading, isAuthenticated } = useAuthenticated(false);
	// The loading screen is for the first answer only. The session is checked again when the
	// tab regains focus (the signer leaves to read the code in their mail), and for a signer
	// with no session yet that check counts as loading again: showing the loading screen then
	// would unmount the invitation and lose the step and the code typed into it.
	const answered = useRef(false);
	if (!loading) answered.current = true;
	if (!invite)
		return (
			<Protected>
				<SignRoute />
			</Protected>
		);
	if (loading && !answered.current) return <BeautifulLoading />;
	return isAuthenticated ? (
		<SignedInWithInvite token={invite} />
	) : (
		<InvitePage token={invite} />
	);
};

const useRouteIds = () => {
	const { organisationId = "", docId = "" } = useParams<{
		organisationId: string;
		docId: string;
	}>();
	return { docId, orgId: organisationId };
};

const useInvite = (token: string) => {
	const { orgId, docId } = useRouteIds();
	return useQuery({
		queryFn: () =>
			call("signerInvite", {
				params: { docId, orgId },
				query: { invite: token },
			}),
		queryKey: ["accounts", "invite", orgId, docId, token],
		retry: false,
	});
};

/** Signed in already: the document when it is theirs, else a stop before it. */
function SignedInWithInvite({ token }: { token: string }) {
	const invite = useInvite(token);
	const me = useV2Me();
	// A link that no longer opens says nothing about who is signed in; the document's own
	// access check decides.
	if (invite.isError) return <SignRoute />;
	if (!invite.data || !me.data) return <BeautifulLoading />;
	const invitee = invite.data.signer.email.toLowerCase();
	if (me.data.email.toLowerCase() === invitee) return <SignRoute />;
	return <NotYou invitee={invitee} email={me.data.email} />;
}

/** Signed in under another address: a stop before anything opens or is accepted. */
function NotYou({ invitee, email }: { invitee: string; email: string }) {
	const queryClient = useQueryClient();
	const [leaving, setLeaving] = useState(false);
	const switchAccount = async () => {
		setLeaving(true);
		await signOut().catch(() => {});
		clearAllDrafts();
		emitAuthCacheBoundary();
		// Reset, not clear: the gate's own session query must refetch to show the invitation.
		await queryClient.resetQueries();
	};
	return (
		<Frame>
			<Stack gap="md" data-testid="invite-not-you">
				<Title order={2} style={{ overflowWrap: "anywhere" }}>
					<Trans>This invitation is for {invitee}</Trans>
				</Title>
				<Text>
					<Trans>
						You're signed in as {email}. Sign out to open it as {invitee}.
					</Trans>
				</Text>
				<Button
					size="md"
					variant="filled"
					loading={leaving}
					onClick={switchAccount}
					data-testid="invite-switch-account"
				>
					<Trans>Sign out and continue</Trans>
				</Button>
				<Group justify="center">
					<Anchor component={I18nLink} to="/o" size="sm">
						<Trans>Stay signed in as {email}</Trans>
					</Anchor>
				</Group>
			</Stack>
		</Frame>
	);
}

/** Before sign-in: the invitation, the names to confirm, then the emailed code. */
function InvitePage({ token }: { token: string }) {
	const { orgId, docId } = useRouteIds();
	const invite = useInvite(token);
	useDocumentTitle(
		invite.data
			? `${invite.data.document.title} | dembrane`
			: t`Sign | dembrane`,
	);
	const signPath = signPathOf(orgId, docId);

	if (invite.isLoading) return <BeautifulLoading />;
	if (!invite.data) {
		const gone =
			invite.error instanceof AccountsApiError &&
			[404, 422].includes(invite.error.status);
		return (
			<Frame>
				<Stack gap="md" data-testid="invite-gone">
					<Title order={2}>
						{gone ? (
							<Trans>This link no longer works</Trans>
						) : (
							<Trans>This invitation could not be loaded</Trans>
						)}
					</Title>
					<Text>
						{gone ? (
							<Trans>
								A newer invitation may have replaced it. Ask the person who
								invited you to send it again.
							</Trans>
						) : (
							<Trans>Check your connection and try again.</Trans>
						)}
					</Text>
					<LogInButton next={signPath} />
				</Stack>
			</Frame>
		);
	}
	if (invite.data.status !== "open")
		return (
			<Frame>
				<Stack gap="md" data-testid="invite-closed">
					<Title order={2}>
						{invite.data.status === "signed" ? (
							<Trans>{invite.data.document.title} is signed</Trans>
						) : (
							<Trans>This document is no longer open for signing</Trans>
						)}
					</Title>
					{invite.data.status === "signed" && (
						<Text>
							<Trans>Log in to download the signed copy.</Trans>
						</Text>
					)}
					<LogInButton next={signPath} />
				</Stack>
			</Frame>
		);
	return <SignerInvite invite={invite.data} token={token} />;
}

/** The signer's invitation, as the shared invitation flow shows it. */
function SignerInvite({ invite, token }: { invite: Invite; token: string }) {
	const { orgId, docId } = useRouteIds();
	const queryClient = useQueryClient();
	const inviter = invite.inviter?.name;
	const org = invite.organisation.name;
	return (
		<OpenInvite
			person={invite.signer}
			hasAccount={invite.has_account}
			banner={
				inviter ? (
					<Trans>
						{inviter} from {org} invited you to sign
					</Trans>
				) : (
					<Trans>{org} invited you to sign</Trans>
				)
			}
			title={invite.document.title}
			reference={invite.document.reference}
			signs
			onAccept={async (names) => {
				await call("acceptSignerInvite", {
					body: { ...names, invite: token },
					params: { docId, orgId },
				});
				resetPromptSeen();
				resetSupportRequestSeen();
				clearAllDrafts();
				emitAuthCacheBoundary();
				// Reset, not clear: nothing of a previous session survives, and the gate's
				// own session query refetches and opens the document.
				await queryClient.resetQueries();
			}}
		/>
	);
}

/**
 * An invitation's page before sign-in, the same for a signer and for someone brought into
 * the data room: who invited them, their names to confirm, a code to their inbox instead
 * of a password, then `onAccept` with the confirmed names. Only signing says that the
 * signature is electronic.
 */
function OpenInvite({
	person,
	hasAccount,
	banner,
	title,
	reference,
	signs,
	onAccept,
}: {
	person: { email: string; first_name: string; last_name: string };
	hasAccount: boolean;
	banner: ReactNode;
	title: ReactNode;
	reference: string | null;
	/** An invitation to sign: says how it signs, and opens "the document". */
	signs: boolean;
	onAccept: (names: {
		first_name: string;
		last_name: string | null;
	}) => Promise<void>;
}) {
	const email = person.email;
	const [first, setFirst] = useState(person.first_name);
	const [last, setLast] = useState(person.last_name);
	const [step, setStep] = useState<"details" | "code">("details");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [elsewhere, setElsewhere] = useState<{ devices: OtherDevice[] } | null>(
		null,
	);
	const [replacementError, setReplacementError] = useState("");
	const resendCooldown = useResendCooldown();

	const sendCode = async () => {
		if (!hasAccount && !first.trim()) {
			setError(t`Fill in your first name.`);
			return;
		}
		const resend = step === "code";
		if (busy || (resend && resendCooldown.wait > 0)) return;
		setBusy(true);
		setError("");
		try {
			await sendSignInCode(email);
			setStep("code");
			setCode("");
			resendCooldown.start();
			if (resend) toast.success(t`We sent a new code to ${email}.`);
		} catch (e) {
			setError(describeAuthError(e));
		} finally {
			setBusy(false);
		}
	};

	// Signed in: keep the confirmed names, then go on (the document, or the room).
	const enter = () =>
		onAccept({
			first_name: first.trim() || email,
			last_name: last.trim() || null,
		});

	const submitCode = async (value: string) => {
		if (busy || value.length < 6) return;
		setBusy(true);
		setError("");
		try {
			await signInWithCode(email, value);
			const state = await otherSessions();
			if (state.held) {
				setReplacementError("");
				setElsewhere({ devices: state.devices });
				return;
			}
			await enter();
		} catch (e) {
			setError(
				e instanceof AccountsApiError
					? t`Something went wrong`
					: describeAuthError(e),
			);
			setCode("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Frame>
			{elsewhere && (
				<SignedInElsewhere
					devices={elsewhere.devices}
					loading={busy}
					error={replacementError}
					onConfirm={async (sessionId) => {
						setBusy(true);
						setReplacementError("");
						try {
							await replaceOtherDevice(sessionId);
							await enter();
						} catch (error) {
							const state = await otherSessions().catch(() => null);
							if (state?.held) setElsewhere({ devices: state.devices });
							const code = authErrorCode(error);
							setReplacementError(
								code === "HTTP_409" || code === "CONFLICT"
									? t`Your active devices changed. Choose a device again.`
									: t`Something went wrong`,
							);
						} finally {
							setBusy(false);
						}
					}}
					onCancel={async () => {
						setElsewhere(null);
						await signOut().catch(() => {});
					}}
				/>
			)}
			<Stack gap="lg" data-testid="invite-page">
				<Stack gap={4}>
					<Text c="dimmed" data-testid="invite-banner">
						{banner}
					</Text>
					<Title order={2}>{title}</Title>
					{reference && (
						<Text size="sm" c="dimmed">
							{reference}
						</Text>
					)}
				</Stack>

				{error && <Alert color="red">{error}</Alert>}

				{step === "details" ? (
					<Stack gap="md">
						{hasAccount ? (
							<Text>
								{signs ? (
									<Trans>
										You already have a dembrane account with {email}. We'll
										email you a code to open the document.
									</Trans>
								) : (
									<Trans>
										You already have a dembrane account with {email}. We'll
										email you a code to log in.
									</Trans>
								)}
							</Text>
						) : (
							<>
								<Text>
									{signs ? (
										<Trans>
											Check your name, and we'll email you a code to open the
											document. You don't need a password.
										</Trans>
									) : (
										<Trans>
											Check your name, and we'll email you a code to log in. You
											don't need a password.
										</Trans>
									)}
								</Text>
								<Group grow gap="sm" align="flex-start">
									<TextInput
										size="md"
										label={<Trans>First name</Trans>}
										autoComplete="given-name"
										value={first}
										onChange={(e) => setFirst(e.currentTarget.value)}
										data-testid="invite-first-name"
									/>
									<TextInput
										size="md"
										label={<Trans>Last name</Trans>}
										autoComplete="family-name"
										value={last}
										onChange={(e) => setLast(e.currentTarget.value)}
										data-testid="invite-last-name"
									/>
								</Group>
							</>
						)}
						<Stack gap="xs" data-testid="invite-email">
							<Text size="sm" c="dimmed">
								<Trans>The invitation was sent to</Trans>
							</Text>
							<Text style={{ overflowWrap: "anywhere" }}>{email}</Text>
						</Stack>
						<Button
							size="md"
							variant="filled"
							mt={8}
							loading={busy}
							onClick={sendCode}
							data-testid="invite-send-code"
						>
							<Trans>Email me a code</Trans>
						</Button>
					</Stack>
				) : (
					<Stack gap="md">
						<Text>
							<Trans>Enter the six-digit code we sent to {email}.</Trans>
						</Text>
						<PinInput
							length={6}
							type="number"
							size="md"
							oneTimeCode
							inputMode="numeric"
							value={code}
							onChange={setCode}
							onComplete={submitCode}
							data-testid="invite-code"
						/>
						<Button
							size="md"
							variant="filled"
							mt={8}
							loading={busy}
							disabled={code.length < 6}
							onClick={() => submitCode(code)}
							data-testid="invite-open"
						>
							{signs ? <Trans>Open the document</Trans> : <Trans>Log in</Trans>}
						</Button>
						{/* The server sends a code only to an address it knows and answers the
						    same either way, so this line is the same for everyone: it must
						    never depend on what the server says about the address. */}
						<Stack gap={4} align="center" data-testid="invite-resend-group">
							<Button
								variant="subtle"
								color="gray"
								disabled={resendCooldown.wait > 0}
								onClick={sendCode}
								data-testid="invite-resend"
							>
								{resendCooldown.wait > 0 ? (
									<Trans>Send a new code in {resendCooldown.wait}s</Trans>
								) : (
									<Trans>Send a new code</Trans>
								)}
							</Button>
							<Text
								size="sm"
								c="dimmed"
								ta="center"
								// Centred under the control, so its lines are balanced, not ragged.
								style={{ textWrap: "balance" }}
								data-testid="invite-no-code"
							>
								<Trans>
									No code after a minute? Check your spam folder, or ask the
									person who shared this with you to add you.
								</Trans>
							</Text>
						</Stack>
					</Stack>
				)}

				<Text size="sm" c="dimmed" data-testid="invite-consent">
					{signs && (
						<>
							<Trans>
								You'll sign electronically. Your electronic signature is as
								binding as one made by hand.
							</Trans>{" "}
						</>
					)}
					<Anchor
						href={LEGAL_PRIVACY_URL}
						target="_blank"
						rel="noreferrer"
						size="sm"
					>
						<Trans>How we handle your details</Trans>
					</Anchor>
				</Text>
			</Stack>
		</Frame>
	);
}

/** One card on parchment, as the emails that lead here look; works on a phone. */
function Frame({ children }: { children: ReactNode }) {
	return (
		<Box
			mih="100dvh"
			px="md"
			py={{ base: 32, sm: 64 }}
			style={{ background: "var(--app-background)" }}
		>
			<Box maw={480} mx="auto">
				<Box mb="lg">
					<Logo hideTitle={false} alwaysDembrane hideEnvBadge />
				</Box>
				<Paper p={{ base: "lg", sm: "xl" }} radius={0} withBorder>
					{children}
				</Paper>
			</Box>
		</Box>
	);
}

// ── the data room's invitation ─────────────────────────────────────────

/**
 * The page the room invitation email links to (/o/:orgId/account/join?invite=): who
 * invited them to which organisation, their names, the same code sign-in as the signer's
 * page, then accept once and land on the organisation's overview, in the room. An
 * accepted invitation offers to log in; a closed or withdrawn one says so; someone signed
 * in under another address is stopped before anything is accepted.
 */
export const RoomJoinGate = () => (
	<AccountsI18n signing>
		<RoomGate />
	</AccountsI18n>
);

const ROOM_HOME = (orgId: string) => `/o/${orgId}/overview`;

const useRoomInvite = (token: string) => {
	const { orgId } = useRouteIds();
	return useQuery({
		queryFn: () =>
			call("roomInvite", { params: { orgId }, query: { invite: token } }),
		queryKey: ["accounts", "room-invite", orgId, token],
		retry: false,
	});
};

const RoomGate = () => {
	const [searchParams] = useSearchParams();
	const token = searchParams.get("invite") ?? "";
	const { loading, isAuthenticated } = useAuthenticated(false);
	// As the signer's gate: the loading screen only for the first answer, so a focus
	// check while the code is being read does not unmount the page.
	const answered = useRef(false);
	if (!loading) answered.current = true;
	if (loading && !answered.current) return <BeautifulLoading />;
	return isAuthenticated ? (
		<RoomSignedIn token={token} />
	) : (
		<RoomInvitePage token={token} />
	);
};

/**
 * Signed in already: accept once when it is theirs and open, then the room, read afresh
 * so it shows at once. A refusal (withdrawn meanwhile, not for them) is said, not retried.
 */
function RoomSignedIn({ token }: { token: string }) {
	const { orgId } = useRouteIds();
	const invite = useRoomInvite(token);
	const me = useV2Me();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const accepting = useRef(false);
	const [failed, setFailed] = useState<unknown>(null);
	const invitee = invite.data?.person.email.toLowerCase() ?? "";
	const mine = Boolean(me.data) && me.data?.email.toLowerCase() === invitee;
	const status = invite.data?.status;
	useEffect(() => {
		if (!mine || accepting.current) return;
		if (status === "accepted") {
			accepting.current = true;
			navigate(ROOM_HOME(orgId));
		} else if (status === "open") {
			accepting.current = true;
			call("acceptRoomInvite", {
				body: {
					first_name: invite.data?.person.first_name || invitee,
					invite: token,
					last_name: invite.data?.person.last_name || null,
				},
				params: { orgId },
			})
				.then(async () => {
					await queryClient.resetQueries();
					navigate(ROOM_HOME(orgId));
				})
				.catch(setFailed);
		}
	}, [mine, status, orgId, token, invitee, invite.data, navigate, queryClient]);
	if (failed)
		return (
			<Frame>
				<Stack gap="md" data-testid="invite-failed">
					<ErrorNotice error={failed} />
					<LogInLink next={ROOM_HOME(orgId)} />
				</Stack>
			</Frame>
		);
	if (invite.isError) return <RoomGone orgId={orgId} />;
	if (!invite.data || !me.data) return <BeautifulLoading />;
	if (!mine) return <NotYou invitee={invitee} email={me.data.email} />;
	if (status === "closed") return <RoomClosed orgId={orgId} />;
	return <BeautifulLoading />;
}

/** Before sign-in: the invitation, or what became of it. */
function RoomInvitePage({ token }: { token: string }) {
	const { orgId } = useRouteIds();
	const invite = useRoomInvite(token);
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	useDocumentTitle(
		invite.data
			? `${invite.data.organisation.name} | dembrane`
			: t`Invitation | dembrane`,
	);
	if (invite.isLoading) return <BeautifulLoading />;
	if (!invite.data) return <RoomGone orgId={orgId} />;
	if (invite.data.status === "closed") return <RoomClosed orgId={orgId} />;
	if (invite.data.status === "accepted")
		return (
			<Frame>
				<Stack gap="md" data-testid="invite-accepted">
					<Title order={2}>
						<Trans>You accepted this invitation</Trans>
					</Title>
					<Text>
						<Trans>Log in to read the offer and the DPA.</Trans>
					</Text>
					<LogInButton next={ROOM_HOME(orgId)} />
				</Stack>
			</Frame>
		);
	const inviter = invite.data.inviter?.name;
	const org = invite.data.organisation.name;
	return (
		<OpenInvite
			person={invite.data.person}
			hasAccount={invite.data.has_account}
			banner={
				inviter ? (
					<Trans>
						{inviter} invited you to {org}
					</Trans>
				) : (
					<Trans>You are invited to {org}</Trans>
				)
			}
			title={
				<DpaHint>
					<span>
						<Trans>Read the offer and the DPA with your team</Trans>
					</span>
				</DpaHint>
			}
			reference={null}
			signs={false}
			onAccept={async (names) => {
				await call("acceptRoomInvite", {
					body: { ...names, invite: token },
					params: { orgId },
				});
				resetPromptSeen();
				resetSupportRequestSeen();
				emitAuthCacheBoundary();
				await queryClient.resetQueries();
				navigate(ROOM_HOME(orgId));
			}}
		/>
	);
}

function RoomGone({ orgId }: { orgId: string }) {
	return (
		<Frame>
			<Stack gap="md" data-testid="invite-gone">
				<Title order={2}>
					<Trans>This link no longer works</Trans>
				</Title>
				<Text>
					<Trans>
						The invitation was withdrawn, or a newer one replaced it. Ask the
						person who invited you to send it again.
					</Trans>
				</Text>
				<LogInLink next={ROOM_HOME(orgId)} />
			</Stack>
		</Frame>
	);
}

function RoomClosed({ orgId }: { orgId: string }) {
	return (
		<Frame>
			<Stack gap="md" data-testid="invite-closed">
				<Title order={2}>
					<Trans>This invitation has closed</Trans>
				</Title>
				<Text>
					<Trans>Ask the person who invited you to send a new one.</Trans>
				</Text>
				<LogInLink next={ROOM_HOME(orgId)} />
			</Stack>
		</Frame>
	);
}

/** On a page that ends here, logging in is a way on, not the page's action: a link. */
function LogInLink({ next }: { next: string }) {
	return (
		<Anchor component={I18nLink} to={logInPath(next)} data-testid="sign-log-in">
			<Trans>Log in</Trans>
		</Anchor>
	);
}
