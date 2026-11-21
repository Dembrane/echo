import { Trans } from "@lingui/react/macro";
import { Alert, Button, Container, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useLogoutMutation } from "@/components/auth/hooks";
import { useV2Me } from "@/hooks/useV2Me";
import { AccountsApiError } from "../api/client";
import { LogInButton, signPath } from "./signInLink";

export type LoadFailure = "signed_out" | "no_access" | "not_found" | "other";

/**
 * Which way the document failed to open. A 403 and a 404 say only what the API already
 * says: someone outside the organisation gets 404 whether or not the document exists.
 */
export const loadFailure = (error: unknown): LoadFailure => {
	if (!(error instanceof AccountsApiError)) return "other";
	if (error.status === 401) return "signed_out";
	if (error.status === 403) return "no_access";
	if (error.status === 404) return "not_found";
	return "other";
};

/**
 * The document did not open. Signed out: log in again and come back here. Signed in
 * under an address the document is not for: say which address is signed in, and switch
 * to the one the offer was sent to. Anything else: the connection, so try again.
 */
export function DocumentLoadError({
	error,
	orgId,
	docId,
	other,
}: {
	error: unknown;
	orgId: string;
	docId: string;
	/** What shows for any other failure (the file error with Try again). */
	other: ReactNode;
}) {
	const kind = loadFailure(error);
	const next = signPath(orgId, docId);
	if (kind === "other") return <>{other}</>;
	if (kind === "signed_out")
		return (
			<Frame testId="sign-error-signed-out">
				<Text size="sm">
					<Trans>You are signed out. Log in again to open this document.</Trans>
				</Text>
				<div>
					<LogInButton next={next} />
				</div>
			</Frame>
		);
	return <WrongAddress kind={kind} next={next} />;
}

function WrongAddress({
	kind,
	next,
}: {
	kind: "no_access" | "not_found";
	next: string;
}) {
	const { data: me } = useV2Me();
	const logout = useLogoutMutation();
	const email = me?.email ?? null;
	return (
		<Frame
			testId={
				kind === "no_access" ? "sign-error-no-access" : "sign-error-not-found"
			}
		>
			<Text size="sm">
				{kind === "no_access" ? (
					email ? (
						<Trans>
							You are signed in as {email}, and this document is not shared with
							that address.
						</Trans>
					) : (
						<Trans>This document is not shared with the address you use.</Trans>
					)
				) : email ? (
					<Trans>
						We could not find this document for {email}. It may have been sent
						to another address.
					</Trans>
				) : (
					<Trans>
						We could not find this document for the address you use. It may have
						been sent to another address.
					</Trans>
				)}
			</Text>
			<Text size="sm">
				<Trans>Log in with the email address the offer was sent to.</Trans>
			</Text>
			<div>
				<Button
					size="md"
					variant="filled"
					loading={logout.isPending}
					onClick={() => logout.mutate({ doRedirect: true, next })}
					data-testid="sign-switch-account"
				>
					<Trans>Log in with another address</Trans>
				</Button>
			</div>
		</Frame>
	);
}

function Frame({ testId, children }: { testId: string; children: ReactNode }) {
	return (
		<Container size="xs" pt="15vh">
			<Alert color="orange" data-testid={testId}>
				<Stack gap="sm">{children}</Stack>
			</Alert>
		</Container>
	);
}
