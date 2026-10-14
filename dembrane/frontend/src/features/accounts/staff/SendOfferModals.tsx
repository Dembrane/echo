import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	CopyButton,
	Group,
	Modal,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import type { DocumentDetailT } from "../contract/contract.gen";

type CustomerEmail = NonNullable<DocumentDetailT["customer_email"]>;

/**
 * Staff: the one question before an offer is placed. dembrane sends no email; the deal
 * owner does, from the window that opens after (CustomerEmailModal).
 */
export function SendOfferConfirmModal({
	opened,
	orgName,
	loading,
	onApprove,
	onCancel,
}: {
	opened: boolean;
	orgName: string;
	loading: boolean;
	onApprove: () => void;
	onCancel: () => void;
}) {
	const org = orgName || t`the customer`;
	return (
		<Modal
			opened={opened}
			onClose={onCancel}
			title={t`Send offer to ${org}`}
			centered
			closeOnClickOutside={!loading}
			closeOnEscape={!loading}
			data-testid="send-offer-confirm"
		>
			<Stack gap="md">
				<Stack gap={4}>
					<Text size="sm">
						<Trans>
							The offer and its documents appear in {org}'s dembrane space.
						</Trans>
					</Text>
					<Text size="sm">
						<Trans>dembrane sends no email. You send the email yourself.</Trans>
					</Text>
				</Stack>
				<Group gap="xs">
					<Button
						variant="filled"
						loading={loading}
						onClick={onApprove}
						data-testid="send-offer-approve"
					>
						<Trans>Approve and place the offer</Trans>
					</Button>
					<Button
						variant="subtle"
						color="gray"
						onClick={onCancel}
						disabled={loading}
					>
						<Trans>Cancel</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/** A mail app opens with the whole email filled in; line breaks as mail expects them. */
const mailtoHref = ({ to, subject, body }: CustomerEmail) =>
	`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, "\r\n"))}`;

function Field({
	label,
	value,
	multiline,
}: {
	label: string;
	value: string;
	multiline?: boolean;
}) {
	return (
		<Stack gap={4} style={{ minWidth: 0 }}>
			<Group gap="xs" align="center">
				<Text size="sm" c="dimmed">
					{label}
				</Text>
				<CopyButton value={value}>
					{({ copied, copy }) => (
						<Button
							size="compact-sm"
							variant="subtle"
							onClick={copy}
							aria-label={t`Copy ${label}`}
						>
							{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
						</Button>
					)}
				</CopyButton>
			</Group>
			<Paper withBorder p="sm" radius="sm">
				<Text
					size="sm"
					style={{
						overflowWrap: "anywhere",
						whiteSpace: multiline ? "pre-wrap" : "normal",
					}}
				>
					{value}
				</Text>
			</Paper>
		</Stack>
	);
}

/**
 * Staff: the email to send the customer, ready to copy. It is shown after an offer is
 * placed and again from the links panel. Nothing is sent from here; the deal owner sends
 * it from their own mail and tells sam in the offer's thread.
 */
export function CustomerEmailModal({
	opened,
	onClose,
	email,
	contactName,
}: {
	opened: boolean;
	onClose: () => void;
	email: CustomerEmail | null;
	contactName: string | null;
}) {
	if (!email) return null;
	const who = contactName || email.to;
	const whole = `${t`To`}: ${email.to}\n${t`Subject`}: ${email.subject}\n\n${email.body}`;
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Email for ${who}`}
			centered
			size="lg"
			data-testid="customer-email"
		>
			<Stack gap="md">
				<Field label={t`To`} value={email.to} />
				<Field label={t`Subject`} value={email.subject} />
				<Field label={t`Body`} value={email.body} multiline />
				<Group gap="md">
					<CopyButton value={whole}>
						{({ copied, copy }) => (
							<Button
								variant="filled"
								onClick={copy}
								data-testid="copy-whole-email"
							>
								{copied ? (
									<Trans>Copied</Trans>
								) : (
									<Trans>Copy the whole email</Trans>
								)}
							</Button>
						)}
					</CopyButton>
					<Anchor
						size="sm"
						c="dimmed"
						href={mailtoHref(email)}
						data-testid="open-mail-app"
					>
						<Trans>Open in your mail app</Trans>
					</Anchor>
				</Group>
				<Text size="sm" c="dimmed">
					<Trans>
						When you have sent it, reply sent in the offer's thread in Slack so
						sam marks the offer as sent.
					</Trans>
				</Text>
				<Group>
					<Button variant="subtle" color="gray" onClick={onClose}>
						<Trans>Done</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
