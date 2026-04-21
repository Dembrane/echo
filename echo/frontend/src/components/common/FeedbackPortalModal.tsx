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
import { getProductFeedbackUrl } from "@/config";
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
						<Text fw={600}>
							<Trans>Scan or click to open the feedback portal</Trans>
						</Text>
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

				<Group justify="flex-end" gap="sm" align="center">
					<Button
						variant="default"
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
