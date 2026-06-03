import { Trans } from "@lingui/react/macro";
import { Badge, Group, Paper, Stack, Text } from "@mantine/core";

export type InviteResultState =
	| "sent" // status: invited (new user) / added (existing user) / reactivated
	| "already_member" // idempotent — already in workspace/org
	| "already_invited" // idempotent — an unaccepted invite is already pending
	| "rate_limited" // 429
	| "seat_cap" // 402
	| "invalid_email" // pre-flight validation
	| "failed";

export interface InviteResultRow {
	email: string;
	workspaceId: string | null; // null = org-only invite
	workspaceName: string | null;
	state: InviteResultState;
	detail?: string;
}

interface Props {
	rows: InviteResultRow[];
	"data-testid"?: string;
}

function badgeForState(state: InviteResultState) {
	switch (state) {
		case "sent":
			return { color: "green", label: <Trans>Sent</Trans> };
		case "already_member":
			return { color: "gray", label: <Trans>Already a member</Trans> };
		case "already_invited":
			return { color: "gray", label: <Trans>Already invited</Trans> };
		case "rate_limited":
			return { color: "yellow", label: <Trans>Rate limited</Trans> };
		case "seat_cap":
			return { color: "yellow", label: <Trans>Seats full</Trans> };
		case "invalid_email":
			return { color: "red", label: <Trans>Invalid email</Trans> };
		case "failed":
		default:
			return { color: "red", label: <Trans>Failed</Trans> };
	}
}

// Per-email result rows shown after submit.
export function InviteResultsList({ rows, "data-testid": dataTestId }: Props) {
	if (rows.length === 0) return null;
	return (
		<Stack gap={6} data-testid={dataTestId}>
			{rows.map((row, idx) => {
				const badge = badgeForState(row.state);
				return (
					<Paper
						key={`${row.email}-${row.workspaceId ?? "org"}-${idx}`}
						withBorder
						p="xs"
						radius="sm"
					>
						<Group justify="space-between" wrap="nowrap" gap="xs">
							<Stack gap={0} style={{ minWidth: 0 }}>
								<Text size="sm" lineClamp={1}>
									{row.email}
								</Text>
								<Text size="xs" c="dimmed" lineClamp={1}>
									{row.workspaceName ? (
										row.workspaceName
									) : (
										<Trans>Organisation only</Trans>
									)}
								</Text>
								{row.detail ? (
									<Text
										size="xs"
										c="dimmed"
										style={{ wordBreak: "break-word" }}
									>
										{row.detail}
									</Text>
								) : null}
							</Stack>
							<Badge
								size="sm"
								variant="light"
								color={badge.color}
								style={{ flexShrink: 0 }}
							>
								{badge.label}
							</Badge>
						</Group>
					</Paper>
				);
			})}
		</Stack>
	);
}
