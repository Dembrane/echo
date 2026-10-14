import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Radio, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import type { OtherDevice } from "@/lib/auth";
import { testId } from "@/lib/testUtils";

/**
 * The page a sign-in lands on when the account has reached its two-device limit: one
 * decision, to sign out one selected device or to go back. It covers the login page it is rendered
 * from, in the look of onboarding, and sits under the transition curtain so the curtain
 * opens onto it.
 */
export const SignedInElsewhere = ({
	devices,
	loading,
	error,
	onConfirm,
	onCancel,
}: {
	devices: OtherDevice[];
	loading: boolean;
	error?: string;
	onConfirm: (sessionId: string) => void;
	onCancel: () => void;
}) => {
	const [ready, setReady] = useState(false);
	const [choice, setChoice] = useState("");
	const selected = devices.some((device) => device.id === choice) ? choice : "";
	useEffect(() => {
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, []);

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
								<Trans>Choose a device to sign out</Trans>
							</Title>
							<Text size="sm" lh={1.6}>
								<Trans>
									Your account can be signed in on up to two devices. Choose one
									to sign out so you can continue here.
								</Trans>
							</Text>
						</Stack>
						<Stack gap="sm">
							<Radio.Group
								value={selected}
								onChange={setChoice}
								aria-label={t`Choose a device to sign out`}
							>
								<Stack gap="sm">
									{devices.map((device) => {
										const { browser, platform } = device;
										const label =
											browser && platform
												? t`${browser} on ${platform}`
												: browser || platform || t`Unknown device`;
										const lastActiveAt = new Date(
											device.lastActiveAt,
										).toLocaleString(undefined, {
											dateStyle: "medium",
											timeStyle: "short",
										});
										return (
											<Radio
												key={device.id}
												value={device.id}
												disabled={loading}
												label={
													<Stack gap={2}>
														<Text size="sm" fw={500}>
															{label}
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>Last active {lastActiveAt}</Trans>
														</Text>
													</Stack>
												}
												styles={{
													root: {
														border:
															"1px solid var(--mantine-color-default-border)",
														borderRadius: 8,
														padding: 14,
													},
												}}
											/>
										);
									})}
								</Stack>
							</Radio.Group>
							{error && (
								<Text role="alert" c="red" size="sm">
									{error}
								</Text>
							)}
							<Button
								variant="filled"
								fullWidth
								size="md"
								loading={loading}
								disabled={!selected}
								onClick={() => {
									if (selected) onConfirm(selected);
								}}
								{...testId("auth-login-elsewhere-confirm")}
							>
								<Trans>Sign out selected device and continue</Trans>
							</Button>
							<Text size="xs" c="dimmed">
								<Trans>The other device will stay signed in.</Trans>
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
