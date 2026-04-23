import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	CopyButton,
	Group,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy, IconGift } from "@tabler/icons-react";
import { toast } from "@/components/common/Toaster";

/**
 * Team-level Referrals tab.
 *
 * First pass — the backend referral pipeline (credit ledger, attribution)
 * lives in follow-up work. For now this surface:
 *   - Shows the team's shareable referral link (deterministic from teamId
 *     so it's honest: links keep working once the credit pipeline lands).
 *   - Explains the mechanic in plain copy.
 *   - Leaves a stats row as "—" with a muted "once your first referral
 *     lands" placeholder, so we don't fake numbers.
 */
interface ReferralsPanelProps {
	teamId: string;
}

function buildReferralLink(teamId: string): string {
	if (typeof window === "undefined") return "";
	return `${window.location.origin}/auth/register?ref=${teamId}`;
}

export function ReferralsPanel({ teamId }: ReferralsPanelProps) {
	const link = buildReferralLink(teamId);

	return (
		<Stack gap="lg">
			<Paper withBorder p="lg" radius="md">
				<Stack gap="md">
					<Group gap="sm" align="center">
						<IconGift size={20} color="var(--mantine-color-blue-6)" />
						<Title order={5} fw={500}>
							<Trans>Invite another team, we both get credit</Trans>
						</Title>
					</Group>
					<Text size="sm" c="dimmed">
						<Trans>
							Share your link with another team. When they upgrade to a
							paid tier, both of you get an hour of usage credit on us.
						</Trans>
					</Text>

					<Group gap="xs" wrap="nowrap" align="center">
						<TextInput
							readOnly
							value={link}
							onFocus={(e) => e.currentTarget.select()}
							style={{ flex: 1 }}
							size="sm"
							aria-label={t`Your referral link`}
						/>
						<CopyButton value={link}>
							{({ copied, copy }) => (
								<Tooltip
									label={copied ? t`Copied` : t`Copy link`}
									withArrow
								>
									<ActionIcon
										variant="default"
										size="lg"
										onClick={() => {
											copy();
											toast.success(t`Link copied`);
										}}
										aria-label={t`Copy referral link`}
									>
										{copied ? (
											<IconCheck size={16} />
										) : (
											<IconCopy size={16} />
										)}
									</ActionIcon>
								</Tooltip>
							)}
						</CopyButton>
						<Button
							component="a"
							href={`mailto:?subject=${encodeURIComponent(
								"Try dembrane",
							)}&body=${encodeURIComponent(
								`I've been using dembrane for research conversations. Thought your team might like it. Sign up here: ${link}`,
							)}`}
							variant="light"
						>
							<Trans>Email it</Trans>
						</Button>
					</Group>
				</Stack>
			</Paper>

			<Paper withBorder p="lg" radius="md">
				<Stack gap="md">
					<Title order={6} fw={500}>
						<Trans>Your referrals</Trans>
					</Title>
					<Group gap="xl" wrap="wrap">
						<Stack gap={2}>
							<Text size="xl" fw={500} c="dimmed">
								—
							</Text>
							<Text size="xs" c="dimmed">
								<Trans>sent</Trans>
							</Text>
						</Stack>
						<Stack gap={2}>
							<Text size="xl" fw={500} c="dimmed">
								—
							</Text>
							<Text size="xs" c="dimmed">
								<Trans>accepted</Trans>
							</Text>
						</Stack>
						<Stack gap={2}>
							<Text size="xl" fw={500} c="dimmed">
								—
							</Text>
							<Text size="xs" c="dimmed">
								<Trans>credits earned</Trans>
							</Text>
						</Stack>
					</Group>
					<Text size="xs" c="dimmed" fs="italic">
						<Trans>
							Stats light up once your first referral lands.
						</Trans>
					</Text>
				</Stack>
			</Paper>
		</Stack>
	);
}
