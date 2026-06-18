import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Radio, Stack, Text } from "@mantine/core";
import { useMemo } from "react";
import { roleLevel } from "@/lib/roles";

export type InviteRole = "member" | "billing" | "admin" | "external";

interface Props {
	value: InviteRole;
	onChange: (role: InviteRole) => void;
	/** Caller's effective role in this org/scope. Filters which options appear. */
	inviterLevel: "member" | "admin" | "owner";
	/** Whether the modal is in workspace-only mode (no zero-workspace submit). */
	allowExternal?: boolean;
	disabled?: boolean;
	"data-testid"?: string;
}

// Role picker for the InviteModal. The same role applies to every selected workspace; options are filtered by inviter hierarchy.
export function RoleSelect({
	value,
	onChange,
	inviterLevel,
	allowExternal = true,
	disabled,
	"data-testid": dataTestId,
}: Props) {
	const inviterRank = roleLevel(inviterLevel);

	const options = useMemo(() => {
		const rows: { value: InviteRole; label: string; description: string }[] = [
			{
				description: t`Standard access. Collaborates in the workspaces they're added to.`,
				label: t`Member`,
				value: "member",
			},
			{
				description: t`Sees usage and invoices. No project or content access.`,
				label: t`Billing`,
				value: "billing",
			},
			{
				description: t`Manages members, workspaces, and organisation settings.`,
				label: t`Admin`,
				value: "admin",
			},
		];
		if (allowExternal) {
			rows.push({
				description: t`Workspace-only guest. Not added to the organisation.`,
				label: t`External`,
				value: "external",
			});
		}
		// Funnel every option through the same hierarchy gate; levels come from lib/roles.ts (mirrors backend policies.py).
		return rows.filter((r) => roleLevel(r.value) <= inviterRank);
	}, [inviterRank, allowExternal]);

	return (
		<Stack gap={6}>
			<Text size="sm" fw={500}>
				<Trans>Role</Trans>
			</Text>
			<Radio.Group
				value={value}
				onChange={(v) => onChange(v as InviteRole)}
				data-testid={dataTestId}
			>
				<Stack gap={6}>
					{options.map((opt) => (
						<Radio
							key={opt.value}
							value={opt.value}
							disabled={disabled}
							label={
								<Stack gap={0}>
									<Text size="sm" fw={500}>
										{opt.label}
									</Text>
									<Text size="xs" c="dimmed">
										{opt.description}
									</Text>
								</Stack>
							}
						/>
					))}
				</Stack>
			</Radio.Group>
			{value === "external" && (
				<Alert
					color="yellow"
					variant="light"
					p="xs"
					styles={{ wrapper: { alignItems: "center" } }}
				>
					<Text size="xs">
						<Trans>
							Externals are not added to your organisation. They can only see
							the workspaces you select here.
						</Trans>
					</Text>
				</Alert>
			)}
		</Stack>
	);
}
