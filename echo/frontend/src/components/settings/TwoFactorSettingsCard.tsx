import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Anchor,
	Button,
	CopyButton,
	Divider,
	Group,
	List,
	Modal,
	Paper,
	PasswordInput,
	PinInput,
	Skeleton,
	Stack,
	Switch,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconCheck,
	IconCopy,
	IconInfoCircle,
	IconLock,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { QRCode } from "@/components/common/QRCode";
import {
	type GenerateTwoFactorResponse,
	useDisableTwoFactorMutation,
	useEnableTwoFactorMutation,
	useGenerateTwoFactorMutation,
} from "./hooks";

interface TwoFactorSettingsCardProps {
	isLoading: boolean;
	isTwoFactorEnabled: boolean;
}

const AUTH_APP_LINKS = [
	{
		href: "https://apps.apple.com/us/app/google-authenticator/id388497605",
		label: "Google Authenticator (iOS)",
	},
	{
		href: "https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2",
		label: "Google Authenticator (Android)",
	},
	{
		href: "https://authy.com/download",
		label: "Authy",
	},
	{
		href: "https://www.microsoft.com/en-us/security/mobile-authenticator-app",
		label: "Microsoft Authenticator",
	},
];

export const TwoFactorSettingsCard = ({
	isLoading,
	isTwoFactorEnabled,
}: TwoFactorSettingsCardProps) => {
	const [
		enableModalOpened,
		{ close: closeEnableModal, open: openEnableModal },
	] = useDisclosure(false);
	const [
		disableModalOpened,
		{ close: closeDisableModal, open: openDisableModal },
	] = useDisclosure(false);

	const generateSecretMutation = useGenerateTwoFactorMutation();
	const enableTwoFactorMutation = useEnableTwoFactorMutation();
	const disableTwoFactorMutation = useDisableTwoFactorMutation();
	const { reset: resetGenerateSecret } = generateSecretMutation;
	const { reset: resetEnableTwoFactor } = enableTwoFactorMutation;
	const { reset: resetDisableTwoFactor } = disableTwoFactorMutation;

	const [password, setPassword] = useState("");
	const [otp, setOtp] = useState("");
	const [disableOtp, setDisableOtp] = useState("");
	const [setupStep, setSetupStep] = useState<"password" | "verify">("password");
	const [generatedSecret, setGeneratedSecret] =
		useState<GenerateTwoFactorResponse | null>(null);

	const isMutating =
		generateSecretMutation.isPending ||
		enableTwoFactorMutation.isPending ||
		disableTwoFactorMutation.isPending;

	useEffect(() => {
		if (!enableModalOpened) {
			setPassword("");
			setOtp("");
			setSetupStep("password");
			setGeneratedSecret(null);
			resetGenerateSecret();
			resetEnableTwoFactor();
		}
	}, [enableModalOpened, resetEnableTwoFactor, resetGenerateSecret]);

	useEffect(() => {
		if (!disableModalOpened) {
			setDisableOtp("");
			resetDisableTwoFactor();
		}
	}, [disableModalOpened, resetDisableTwoFactor]);

	const handleToggle = () => {
		if (isTwoFactorEnabled) {
			openDisableModal();
			return;
		}
		openEnableModal();
	};

	const handleGenerateSecret = async () => {
		if (!password) return;
		try {
			const data = await generateSecretMutation.mutateAsync({ password });
			if (data) {
				setGeneratedSecret(data);
				setSetupStep("verify");
				setPassword("");
			}
		} catch (_error) {
			// handled in mutation onError
		}
	};

	const handleEnableTwoFactor = async (submittedOtp?: string) => {
		if (!generatedSecret || enableTwoFactorMutation.isPending) return;
		const trimmedOtp = (submittedOtp ?? otp).trim();
		if (trimmedOtp.length < 6) return;

		try {
			await enableTwoFactorMutation.mutateAsync({
				otp: trimmedOtp,
				secret: generatedSecret.secret,
			});
			closeEnableModal();
		} catch (_error) {
			// handled in mutation onError
		}
	};

	const handleDisableTwoFactor = async (submittedOtp?: string) => {
		if (disableTwoFactorMutation.isPending) return;
		const trimmedOtp = (submittedOtp ?? disableOtp).trim();
		if (trimmedOtp.length < 6) return;
		try {
			await disableTwoFactorMutation.mutateAsync({ otp: trimmedOtp });
			closeDisableModal();
		} catch (_error) {
			// handled in mutation onError
		}
	};

	const renderEnableModalContent = () => {
		if (setupStep === "password") {
			return (
				<Stack gap="lg">
					{generateSecretMutation.isError && (
						<Alert color="red" variant="light">
							{generateSecretMutation.error?.message ??
								t`Something went wrong while generating the secret.`}
						</Alert>
					)}

					<Text>
						<Trans>
							Confirm your password to generate a new secret for your
							authenticator app.
						</Trans>
					</Text>

					<PasswordInput
						label={t`Account password`}
						placeholder={t`Enter your password`}
						value={password}
						onChange={(event) => setPassword(event.currentTarget.value)}
						data-autofocus
						disabled={generateSecretMutation.isPending}
					/>

					<Group justify="flex-end">
						<Button
							onClick={handleGenerateSecret}
							loading={generateSecretMutation.isPending}
							disabled={!password}
						>
							<Trans>Generate secret</Trans>
						</Button>
					</Group>
				</Stack>
			);
		}

		if (!generatedSecret) {
			return null;
		}

		return (
			<Stack gap="lg">
				{enableTwoFactorMutation.isError && (
					<Alert color="red" variant="light">
						{enableTwoFactorMutation.error?.message ??
							t`We couldn’t enable two-factor authentication. Double-check your code and try again.`}
					</Alert>
				)}

				<Text>
					<Trans>Scan the QR code or copy the secret into your app.</Trans>
				</Text>

				<Paper withBorder p="md" radius="md">
					<Stack gap="sm" align="center">
						<div className="h-[200px] w-[200px]">
							<QRCode value={generatedSecret.otpauth_url} />
						</div>
						<Group align="center" gap="xs">
							<Text fw={600} size="lg">
								{generatedSecret.secret}
							</Text>
							<CopySecretButton secret={generatedSecret.secret} />
						</Group>
					</Stack>
				</Paper>

				<Stack gap="xs">
					<Text fw={500} size="sm">
						<Trans>Authenticator code</Trans>
					</Text>
					<PinInput
						length={6}
						type="number"
						size="md"
						oneTimeCode
						value={otp}
						onChange={(value) => setOtp(value)}
						onComplete={(value) => handleEnableTwoFactor(value)}
						inputMode="numeric"
						disabled={enableTwoFactorMutation.isPending}
					/>
					<Text size="sm" c="dimmed">
						<Trans>
							Enter the current six-digit code from your authenticator app.
						</Trans>
					</Text>
				</Stack>

				<Group justify="space-between">
					<Button
						variant="subtle"
						onClick={() => {
							setSetupStep("password");
							setGeneratedSecret(null);
						}}
					>
						<Trans>Start over</Trans>
					</Button>
					<Button
						onClick={() => handleEnableTwoFactor()}
						loading={enableTwoFactorMutation.isPending}
						disabled={otp.trim().length < 6}
					>
						<Trans>Enable 2FA</Trans>
					</Button>
				</Group>
			</Stack>
		);
	};

	return (
		<>
			<Paper withBorder p="lg" radius="lg">
				<Stack gap="lg">
					<Group justify="space-between" align="flex-start">
						<Stack gap={2}>
							<Group gap="sm" align="center">
								<IconLock size={20} />
								<Text size="lg" fw={600}>
									<Trans>Two-factor authentication</Trans>
								</Text>
							</Group>
							<Text size="sm" c="dimmed" maw={520}>
								<Trans>
									Keep access secure with a one-time code from your
									authenticator app. Toggle two-factor authentication for this
									account.
								</Trans>
							</Text>
						</Stack>

						<Stack gap={8} align="flex-end">
							{isLoading ? (
								<Skeleton height={32} width={80} />
							) : (
								<Switch
									size="md"
									checked={isTwoFactorEnabled}
									label={isTwoFactorEnabled ? t`Enabled` : t`Disabled`}
									onChange={handleToggle}
									disabled={isLoading || isMutating}
								/>
							)}
						</Stack>
					</Group>

					{!isTwoFactorEnabled && (
						<>
							<Divider />

							<Stack gap="md">
								<Group gap="xs" align="center">
									<Text fw={500}>
										<Trans>Recommended apps</Trans>
									</Text>
								</Group>

								<List spacing={6} size="sm">
									{AUTH_APP_LINKS.map((link) => (
										<List.Item key={link.href}>
											<Anchor href={link.href} target="_blank" rel="noreferrer">
												{link.label}
											</Anchor>
										</List.Item>
									))}
								</List>
							</Stack>
						</>
					)}
				</Stack>
			</Paper>

			<Modal
				opened={enableModalOpened}
				onClose={closeEnableModal}
				title={<Trans>Enable two-factor authentication</Trans>}
				size="lg"
			>
				{renderEnableModalContent()}
			</Modal>

			<Modal
				opened={disableModalOpened}
				onClose={closeDisableModal}
				title={<Trans>Disable two-factor authentication</Trans>}
				size="md"
			>
				<Stack gap="lg">
					<Text>
						<Trans>
							Enter a valid code to turn off two-factor authentication.
						</Trans>
					</Text>

					<Stack gap="xs">
						<Text fw={500} size="sm">
							<Trans>Authenticator code</Trans>
						</Text>
						<PinInput
							length={6}
							type="number"
							size="md"
							oneTimeCode
							value={disableOtp}
							onChange={(value) => setDisableOtp(value)}
							onComplete={(value) => handleDisableTwoFactor(value)}
							inputMode="numeric"
							disabled={disableTwoFactorMutation.isPending}
						/>
					</Stack>

					{disableTwoFactorMutation.isError && (
						<Alert color="red" variant="light">
							{disableTwoFactorMutation.error?.message ??
								t`We couldn’t disable two-factor authentication. Try again with a fresh code.`}
						</Alert>
					)}

					<Group justify="flex-end">
						<Button variant="subtle" onClick={closeDisableModal}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							color="red"
							onClick={() => handleDisableTwoFactor()}
							loading={disableTwoFactorMutation.isPending}
							disabled={disableOtp.trim().length < 6}
						>
							<Trans>Disable 2FA</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
};

const CopySecretButton = ({ secret }: { secret: string }) => {
	if (!secret) {
		return null;
	}

	return (
		<CopyButton value={secret} timeout={2000}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? t`Copied` : t`Copy secret`} withArrow>
					<ActionIcon
						variant="subtle"
						color={copied ? "teal" : "gray"}
						onClick={copy}
						aria-label={copied ? t`Secret copied` : t`Copy secret`}
					>
						{copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
					</ActionIcon>
				</Tooltip>
			)}
		</CopyButton>
	);
};
