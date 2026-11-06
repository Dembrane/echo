import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Box,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	CaretDownIcon,
	CaretRightIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { AccountsApiError } from "../api/client";
import { useAccountEmail } from "../api/hooks";
import type { AccountEmailT } from "../contract/contract.gen";
import { formatDateTime } from "../format";
import { Section } from "../ui";

type Thread = AccountEmailT["threads"][number];
type Message = Thread["messages"][number];

const FIRST = 8;

/**
 * Staff: the organisation's email with dembrane, read live from our mailboxes and shown as
 * chats, one bubble per message with the quoted history cut off. Read-only: each thread
 * opens in Gmail to reply.
 */
export function EmailSection({ orgId }: { orgId: string }) {
	const q = useAccountEmail(orgId);
	const [refreshing, setRefreshing] = useState(false);
	const [all, setAll] = useState(false);

	const refresh = async () => {
		setRefreshing(true);
		try {
			await q.refresh();
		} finally {
			setRefreshing(false);
		}
	};

	const action = q.data ? (
		<Tooltip label={t`Check the mailboxes again`}>
			<ActionIcon
				variant="subtle"
				color="gray"
				loading={refreshing}
				onClick={() => void refresh()}
				aria-label={t`Check the mailboxes again`}
				data-testid="email-refresh"
			>
				<ArrowClockwiseIcon size={16} />
			</ActionIcon>
		</Tooltip>
	) : null;

	return (
		<Section
			title={<Trans>Email</Trans>}
			action={action}
			testId="account-email"
		>
			<Body
				data={q.data}
				error={q.error}
				loading={q.isLoading}
				all={all}
				onAll={() => setAll((v) => !v)}
			/>
		</Section>
	);
}

function Body({
	data,
	error,
	loading,
	all,
	onAll,
}: {
	data: AccountEmailT | undefined;
	error: unknown;
	loading: boolean;
	all: boolean;
	onAll: () => void;
}) {
	if (loading)
		return (
			<Group gap="xs">
				<Loader size="xs" />
				<Text size="sm" c="dimmed">
					<Trans>Reading the mailboxes…</Trans>
				</Text>
			</Group>
		);
	if (error || !data) {
		const notConnected =
			error instanceof AccountsApiError && error.status === 503;
		return (
			<Text size="sm" c="dimmed">
				{notConnected ? (
					<Trans>Email is not connected in this environment.</Trans>
				) : (
					<Trans>The mailboxes could not be read. Try again in a minute.</Trans>
				)}
			</Text>
		);
	}
	const failed = data.mailboxes.filter((m) => !m.ok).map((m) => m.mailbox);
	const matched = [...data.matched.domains, ...data.matched.addresses];
	const shown = all ? data.threads : data.threads.slice(0, FIRST);
	return (
		<Stack gap="sm">
			{failed.length > 0 && (
				<Text size="xs" c="orange">
					<Trans>Not read this time: {failed.join(", ")}</Trans>
				</Text>
			)}
			{matched.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>
						No members with an email address yet, so there is no mail to match.
					</Trans>
				</Text>
			) : data.threads.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>
						No email with {matched.join(", ")} in the last two years.
					</Trans>
				</Text>
			) : (
				shown.map((thread, i) => (
					<ThreadCard key={thread.id} thread={thread} open={i === 0} />
				))
			)}
			{data.threads.length > FIRST && (
				<Anchor component="button" size="xs" ta="left" onClick={onAll}>
					{all ? <Trans>Show less</Trans> : <Trans>Show all</Trans>}
				</Anchor>
			)}
		</Stack>
	);
}

function ThreadCard({ thread, open }: { thread: Thread; open: boolean }) {
	const { i18n } = useLingui();
	const [expanded, setExpanded] = useState(open);
	const count = thread.messages.length;
	const them = thread.participants
		.filter((p) => p.side !== "dembrane")
		.map((p) => p.name ?? p.email);
	return (
		<Paper withBorder radius="md" p="sm" data-testid="email-thread">
			<UnstyledButton
				onClick={() => setExpanded((v) => !v)}
				w="100%"
				aria-expanded={expanded}
			>
				<Group gap="xs" wrap="nowrap" align="flex-start">
					<Box pt={2}>
						{expanded ? (
							<CaretDownIcon size={14} />
						) : (
							<CaretRightIcon size={14} />
						)}
					</Box>
					<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
						<Text size="sm" fw={500} truncate>
							{thread.subject}
						</Text>
						<Text size="xs" c="dimmed" truncate>
							{them.join(", ")} ·{" "}
							{count === 1 ? t`1 message` : t`${count} messages`} ·{" "}
							{formatDateTime(thread.last_message_at, i18n.locale)}
						</Text>
					</Stack>
				</Group>
			</UnstyledButton>
			{expanded && (
				<Stack gap="xs" mt="sm">
					{thread.messages.map((m) => (
						<Bubble key={m.id} message={m} />
					))}
					<Group gap="xs" justify="flex-end" mt={4}>
						{thread.gmail.map((g) => (
							<Button
								key={g.mailbox}
								component="a"
								href={g.url}
								target="_blank"
								rel="noopener noreferrer"
								size="compact-xs"
								variant="light"
								rightSection={<ArrowSquareOutIcon size={12} />}
								data-testid="email-open-gmail"
							>
								{thread.gmail.length === 1 ? (
									<Trans>Open in Gmail</Trans>
								) : (
									<Trans>Open in {g.mailbox.split("@")[0]}'s Gmail</Trans>
								)}
							</Button>
						))}
					</Group>
				</Stack>
			)}
		</Paper>
	);
}

function Bubble({ message }: { message: Message }) {
	const { i18n } = useLingui();
	const ours = message.from.side === "dembrane";
	return (
		<Stack gap={2} align={ours ? "flex-end" : "flex-start"}>
			<Text size="xs" c="dimmed">
				{message.from.name ?? message.from.email} ·{" "}
				{formatDateTime(message.sent_at, i18n.locale)}
			</Text>
			<Box
				px="sm"
				py={6}
				maw="85%"
				bg={
					ours
						? "var(--mantine-color-blue-light)"
						: "var(--mantine-color-gray-light)"
				}
				style={{ borderRadius: 12 }}
			>
				<Text
					size="sm"
					style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
				>
					{message.text}
				</Text>
			</Box>
		</Stack>
	);
}
