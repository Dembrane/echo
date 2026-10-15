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
import { type ReactNode, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { SignedInElsewhere } from "@/components/auth/SignedInElsewhere";
import {
	authErrorCode,
	describeAuthError,
} from "@/components/auth/utils/errorUtils";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { I18nLink } from "@/components/common/i18nLink";
import { Logo } from "@/components/common/Logo";
import { Protected } from "@/components/common/Protected";
import { LEGAL_PRIVACY_URL } from "@/config";
import { resetPromptSeen } from "@/features/accounts/help/tasksPromptState";
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
import { AccountsI18n } from "../i18n";
import { SignRoute } from "./SignRoute";

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
	<AccountsI18n>
		<Gate />
	</AccountsI18n>
);

const Gate = () => {
	const [searchParams] = useSearchParams();
	const invite = searchParams.get("invite");
	const { loading, isAuthenticated } = useAuthenticated(false);
	if (!invite)
		return (
			<Protected>
				<SignRoute />
			</Protected>
		);
	if (loading) return <BeautifulLoading />;
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
	const queryClient = useQueryClient();
	const [leaving, setLeaving] = useState(false);
	// A link that no longer opens says nothing about who is signed in; the document's own
	// access check decides.
	if (invite.isError) return <SignRoute />;
	if (!invite.data || !me.data) return <BeautifulLoading />;
	const invitee = invite.data.signer.email.toLowerCase();
	if (me.data.email.toLowerCase() === invitee) return <SignRoute />;

	const switchAccount = async () => {
		setLeaving(true);
		await signOut().catch(() => {});
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
						You're signed in as {me.data.email}. Sign out to open it as{" "}
						{invitee}.
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
						<Trans>Stay signed in as {me.data.email}</Trans>
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
	const signPath = `/o/${orgId}/account/documents/${docId}/sign`;

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
	return <OpenInvite invite={invite.data} token={token} />;
}

function OpenInvite({ invite, token }: { invite: Invite; token: string }) {
	const { orgId, docId } = useRouteIds();
	const queryClient = useQueryClient();
	const email = invite.signer.email;
	const [first, setFirst] = useState(invite.signer.first_name);
	const [last, setLast] = useState(invite.signer.last_name);
	const [step, setStep] = useState<"details" | "code">("details");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [elsewhere, setElsewhere] = useState<{ devices: OtherDevice[] } | null>(
		null,
	);
	const [replacementError, setReplacementError] = useState("");

	const sendCode = async () => {
		if (!invite.has_account && !first.trim()) {
			setError(t`Fill in your first name.`);
			return;
		}
		setBusy(true);
		setError("");
		try {
			await sendSignInCode(email);
			setStep("code");
			setCode("");
		} catch (e) {
			setError(describeAuthError(e));
		} finally {
			setBusy(false);
		}
	};

	// Signed in: keep the confirmed names, then let the gate open the document.
	const enter = async () => {
		await call("acceptSignerInvite", {
			body: {
				first_name: first.trim() || email,
				invite: token,
				last_name: last.trim() || null,
			},
			params: { docId, orgId },
		});
		resetPromptSeen();
		emitAuthCacheBoundary();
		// Reset, not clear: nothing of a previous session survives, and the gate's own
		// session query refetches and opens the document.
		await queryClient.resetQueries();
	};

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

	const inviter = invite.inviter?.name;
	const org = invite.organisation.name;
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
						{inviter ? (
							<Trans>
								{inviter} from {org} invited you to sign
							</Trans>
						) : (
							<Trans>{org} invited you to sign</Trans>
						)}
					</Text>
					<Title order={2}>{invite.document.title}</Title>
					{invite.document.reference && (
						<Text size="sm" c="dimmed">
							{invite.document.reference}
						</Text>
					)}
				</Stack>

				{error && <Alert color="red">{error}</Alert>}

				{step === "details" ? (
					<Stack gap="md">
						{invite.has_account ? (
							<Text>
								<Trans>
									You already have a dembrane account with {email}. We'll email
									you a code to open the document.
								</Trans>
							</Text>
						) : (
							<>
								<Text>
									<Trans>
										Check your name, and we'll email you a code to open the
										document. You don't need a password.
									</Trans>
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
							<Trans>Open the document</Trans>
						</Button>
						<Group justify="center">
							<Button variant="subtle" color="gray" onClick={sendCode}>
								<Trans>Send a new code</Trans>
							</Button>
						</Group>
					</Stack>
				)}

				<Text size="sm" c="dimmed" data-testid="invite-consent">
					<Trans>
						You'll sign electronically. Your electronic signature is as binding
						as one made by hand.
					</Trans>{" "}
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

function LogInButton({ next }: { next: string }) {
	return (
		<Button
			component={I18nLink}
			to={`/login?next=${encodeURIComponent(next)}`}
			size="md"
			variant="filled"
		>
			<Trans>Log in</Trans>
		</Button>
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
