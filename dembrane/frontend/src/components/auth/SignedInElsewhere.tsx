import { Trans } from "@lingui/react/macro";
import { Button, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { testId } from "@/lib/testUtils";

/**
 * The page a sign-in lands on when the account is logged in on another browser: one
 * decision, to log that browser out or to go back. It covers the login page it is rendered
 * from, in the look of onboarding, and sits under the transition curtain so the curtain
 * opens onto it.
 */
export const SignedInElsewhere = ({
	since,
	loading,
	onConfirm,
	onCancel,
}: {
	/** When the other browser logged in, as an ISO time; null when unknown. */
	since: string | null;
	loading: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) => {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	const elsewhereSince = since
		? new Date(since).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;

	return (
		<div
			style={{
				background: "var(--app-background)",
				display: "flex",
				flexDirection: "column",
				inset: 0,
				overflow: "hidden",
				position: "fixed",
				zIndex: 90,
			}}
			{...testId("auth-login-elsewhere")}
		>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flex: "1 1 auto",
					justifyContent: "center",
					overflowY: "auto",
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
					<Stack gap="lg">
						<Stack gap="xs">
							<Title order={2}>
								<Trans>This account is logged in somewhere else</Trans>
							</Title>
							<Text size="sm" lh={1.6}>
								{elsewhereSince ? (
									<Trans>
										It has been logged in on another device since{" "}
										{elsewhereSince}. For security, an account can be logged in
										on one device at a time.
									</Trans>
								) : (
									<Trans>
										It is logged in on another device. For security, an account
										can be logged in on one device at a time.
									</Trans>
								)}
							</Text>
						</Stack>
						<Stack gap="sm">
							<Button
								variant="filled"
								fullWidth
								size="md"
								loading={loading}
								onClick={onConfirm}
								{...testId("auth-login-elsewhere-confirm")}
							>
								<Trans>Log in anyway</Trans>
							</Button>
							<Text size="xs" c="dimmed">
								<Trans>Logging in here logs the other device out.</Trans>
							</Text>
							<Button
								fullWidth
								variant="subtle"
								color="gray"
								disabled={loading}
								onClick={onCancel}
								{...testId("auth-login-elsewhere-cancel")}
							>
								<Trans>Back to log in</Trans>
							</Button>
						</Stack>
					</Stack>
				</div>
			</div>
		</div>
	);
};
