import { Trans } from "@lingui/react/macro";
import { Group, Progress, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { type PasswordStrength, validatePassword } from "@/lib/passwordPolicy";

const STRENGTH_BAR: Record<PasswordStrength, { value: number; color: string }> =
	{
		fair: { color: "yellow", value: 66 },
		strong: { color: "teal", value: 100 },
		weak: { color: "red", value: 33 },
	};

const Requirement = ({ met, label }: { met: boolean; label: ReactNode }) => (
	<Group gap="xs" wrap="nowrap">
		<ThemeIcon
			size={18}
			radius="xl"
			variant={met ? "filled" : "light"}
			color={met ? "teal" : "gray"}
		>
			{met ? <IconCheck size={12} /> : <IconX size={12} />}
		</ThemeIcon>
		<Text size="xs" c={met ? undefined : "dimmed"}>
			{label}
		</Text>
	</Group>
);

export const PasswordRequirements = ({ value }: { value: string }) => {
	const { rules, strength } = validatePassword(value);
	const bar = STRENGTH_BAR[strength];

	return (
		<Stack gap="xs" mt="xs">
			<Progress
				value={value.length === 0 ? 0 : bar.value}
				color={value.length === 0 ? "gray" : bar.color}
				size="sm"
			/>
			{value.length > 0 && (
				<Text size="xs" c="dimmed">
					{strength === "strong" ? (
						<Trans>Strong password</Trans>
					) : strength === "fair" ? (
						<Trans>Fair password</Trans>
					) : (
						<Trans>Weak password</Trans>
					)}
				</Text>
			)}
			<Stack gap={4}>
				<Requirement
					met={rules.minLength}
					label={<Trans>At least 8 characters</Trans>}
				/>
				<Requirement
					met={rules.uppercase}
					label={<Trans>One uppercase letter</Trans>}
				/>
				<Requirement
					met={rules.lowercase}
					label={<Trans>One lowercase letter</Trans>}
				/>
				<Requirement met={rules.number} label={<Trans>One number</Trans>} />
				<Requirement met={rules.symbol} label={<Trans>One symbol</Trans>} />
			</Stack>
		</Stack>
	);
};
