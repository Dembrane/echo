import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	Divider,
	Group,
	Modal,
	rem,
	Stack,
	Text,
} from "@mantine/core";
import { UsersThree } from "@phosphor-icons/react";
import { COMMUNITY_SLACK_URL, getProductFeedbackUrl } from "@/config";
import { QRCode } from "./QRCode";

interface FeedbackPortalModalProps {
	opened: boolean;
	onClose: () => void;
	locale?: string;
}

export const FeedbackPortalModal = ({
	opened,
	onClose,
	locale,
}: FeedbackPortalModalProps) => {
	const feedbackUrl = getProductFeedbackUrl(locale);

	const actionButtonStyles = {
		root: {
			minHeight: rem(40),
			paddingBottom: rem(10),
			paddingLeft: rem(20),
			paddingRight: rem(20),
			paddingTop: rem(10),
		},
	} as const;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Feedback portal`}
			centered
		>
			<Stack gap="lg">
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							We'd love to hear from you. Whether you have an idea for something
							new, you've hit a bug, spotted a translation that feels off, or
							just want to share how things have been going.
						</Trans>
					</Text>
					<Text size="sm">
						<Trans>
							To help us act on it, try to include where it happened and what
							you were trying to do. For bugs, tell us what went wrong. For
							ideas, tell us what need it would solve for you.
						</Trans>
					</Text>
					<Text size="sm">
						<Trans>
							Just talk or type naturally. Your input goes directly to our
							product team and genuinely helps us make dembrane better. We read
							everything.
						</Trans>
					</Text>
				</Stack>

				<Group align="center" gap="lg" wrap="nowrap">
					<QRCode
						value={feedbackUrl}
						href={feedbackUrl}
						className="h-auto w-full min-w-[80px] max-w-[128px]"
					/>
					<Stack gap={4}>
						<Anchor
							href={feedbackUrl}
							target="_blank"
							rel="noopener noreferrer"
							fw={600}
							c="inherit"
							underline="hover"
						>
							<Trans>Scan or click the QR code to open the feedback portal</Trans>
						</Anchor>
						<Group gap="xs">
							<Text size="xs" c="dimmed">
								<Trans>Or prefer to chat directly?</Trans>
							</Text>
							<Anchor
								href="https://cal.com/sameer-dembrane"
								target="_blank"
								size="xs"
							>
								<Trans>Book a call with us</Trans>
							</Anchor>
						</Group>
					</Stack>
				</Group>

				<Divider />

				<Group justify="space-between" gap="sm" align="center">
					<Anchor
						href={COMMUNITY_SLACK_URL}
						target="_blank"
						rel="noopener noreferrer"
						size="sm"
					>
						<Group gap={6} wrap="nowrap">
							<UsersThree size={16} />
							<Trans>Join our Slack community</Trans>
						</Group>
					</Anchor>
					<Button
						variant="subtle"
						size="md"
						onClick={onClose}
						styles={actionButtonStyles}
					>
						<Trans>Cancel</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
