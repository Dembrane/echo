import { Trans } from "@lingui/react/macro";
import { Alert, Stack, Text } from "@mantine/core";
import { ClockIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

/** 75 -> "1:15", 9 -> "0:09": a clock reads the same in every language. */
export function formatWait(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Says that sign-in is paused and counts down to when it opens again. The parent owns the
 * countdown (useResendCooldown) and disables its own button while `seconds` is above zero.
 * `flow` keeps the wording right: a password login never mentions a code.
 */
export const LoginRateLimitNotice = ({
	seconds,
	flow = "password",
}: {
	seconds: number;
	flow?: "password" | "code";
}) => {
	const clock = formatWait(seconds);
	return (
		<Alert icon={<ClockIcon size={20} />} {...testId("auth-login-rate-limit")}>
			<Stack gap={4}>
				<Text size="sm">
					{flow === "code" ? (
						<Trans>
							Too many tries. Wait a moment, then request a new code.
						</Trans>
					) : (
						<Trans>
							Too many login attempts. Wait a moment, then try again.
						</Trans>
					)}
				</Text>
				<Text
					size="sm"
					aria-live="polite"
					{...testId("auth-login-rate-limit-wait")}
				>
					{seconds > 0 ? (
						<Trans>You can try again in {clock}.</Trans>
					) : (
						<Trans>You can try again now.</Trans>
					)}
				</Text>
			</Stack>
		</Alert>
	);
};
