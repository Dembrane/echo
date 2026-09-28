import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useAccountsMutation } from "../api/hooks";
import type { TicketT } from "../contract/contract.gen";
import { formatDateTime, ticketStatusLabel } from "../format";
import { Section } from "../ui";

/**
 * Questions and answers with dembrane. Shared by the customer page and the staff card:
 * `side` says whose replies are ours, and which routes the replies go through.
 */
export function Questions({
	orgId,
	tickets,
	side = "customer",
	extraAction,
}: {
	orgId: string;
	tickets: TicketT[];
	side?: "customer" | "staff";
	/** Sits next to "Ask a question": the customer page puts "Book a call" here. */
	extraAction?: React.ReactNode;
}) {
	const [asking, setAsking] = useState(false);
	return (
		<Section
			title={<Trans>Questions</Trans>}
			testId="questions"
			action={
				<Group gap="xs">
					{extraAction}
					{!asking && (
						<Button
							size="xs"
							variant="light"
							onClick={() => setAsking(true)}
							data-testid="ask-question"
						>
							{side === "customer" ? (
								<Trans>Ask a question</Trans>
							) : (
								<Trans>New message</Trans>
							)}
						</Button>
					)}
				</Group>
			}
		>
			<Stack gap="xs">
				{asking && (
					<AskForm orgId={orgId} side={side} onDone={() => setAsking(false)} />
				)}
				{tickets.length === 0 && !asking && (
					<Text size="sm" c="dimmed">
						<Trans>No questions yet.</Trans>
					</Text>
				)}
				{tickets.length > 0 && (
					<Accordion variant="separated" radius="md" chevronPosition="right">
						{tickets.map((ticket) => (
							<TicketItem
								key={ticket.id}
								ticket={ticket}
								orgId={orgId}
								side={side}
							/>
						))}
					</Accordion>
				)}
			</Stack>
		</Section>
	);
}

function TicketItem({
	ticket,
	orgId,
	side,
}: {
	ticket: TicketT;
	orgId: string;
	side: "customer" | "staff";
}) {
	const { i18n } = useLingui();
	const [reply, setReply] = useState("");
	const mutation = useAccountsMutation(
		side === "customer" ? "replyTicket" : "staffReplyTicket",
		{
			orgId,
			ticketId: ticket.id,
		},
	);
	const ours = side === "customer" ? "customer" : "dembrane";
	const send = (close = false) =>
		mutation.mutate(
			// Only the staff route takes `close`; the customer route ignores nothing it is sent.
			{
				body: (side === "customer"
					? { body: reply }
					: { body: reply, close }) as { body: string },
			},
			{ onSuccess: () => setReply("") },
		);
	return (
		<Accordion.Item value={ticket.id} data-testid="ticket">
			<Accordion.Control>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					<Text size="sm" truncate>
						{ticket.subject}
					</Text>
					<Badge
						size="sm"
						variant="light"
						color={ticket.status === "waiting_on_customer" ? "blue" : "gray"}
						style={{ flexShrink: 0 }}
					>
						{ticketStatusLabel(ticket.status)}
					</Badge>
				</Group>
			</Accordion.Control>
			<Accordion.Panel>
				<Stack gap="xs">
					{ticket.messages.map((m) => (
						<Box
							key={m.id}
							style={{
								alignSelf: m.from === ours ? "flex-end" : "flex-start",
								maxWidth: "85%",
							}}
						>
							<Paper
								p="xs"
								radius="md"
								bg={m.from === ours ? "blue.0" : "gray.1"}
							>
								<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
									{m.body}
								</Text>
							</Paper>
							<Text
								size="xs"
								c="dimmed"
								ta={m.from === ours ? "right" : "left"}
								mt={2}
							>
								{m.from === "dembrane"
									? "dembrane"
									: side === "customer"
										? t`You`
										: t`Customer`}{" "}
								· {formatDateTime(m.created_at, i18n.locale)}
							</Text>
						</Box>
					))}
					{ticket.status !== "closed" && (
						<Stack gap={6}>
							<Textarea
								aria-label={t`Reply`}
								placeholder={t`Write a reply`}
								autosize
								minRows={2}
								value={reply}
								onChange={(e) => setReply(e.currentTarget.value)}
							/>
							<Group justify="flex-end" gap="xs">
								{side === "staff" && (
									<Button
										variant="default"
										size="xs"
										disabled={!reply.trim()}
										onClick={() => send(true)}
									>
										<Trans>Reply and close</Trans>
									</Button>
								)}
								<Button
									size="xs"
									disabled={!reply.trim()}
									loading={mutation.isPending}
									onClick={() => send()}
									data-testid="ticket-reply"
								>
									<Trans>Reply</Trans>
								</Button>
							</Group>
						</Stack>
					)}
				</Stack>
			</Accordion.Panel>
		</Accordion.Item>
	);
}

function AskForm({
	orgId,
	side,
	onDone,
}: {
	orgId: string;
	side: "customer" | "staff";
	onDone: () => void;
}) {
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const mutation = useAccountsMutation(
		side === "customer" ? "openTicket" : "staffOpenTicket",
		{ orgId },
	);
	return (
		<Paper withBorder p="sm" radius="md">
			<Stack gap="xs">
				<TextInput
					label={t`Subject`}
					value={subject}
					onChange={(e) => setSubject(e.currentTarget.value)}
					data-testid="question-subject"
				/>
				<Textarea
					label={side === "customer" ? t`Your question` : t`Message`}
					autosize
					minRows={3}
					value={body}
					onChange={(e) => setBody(e.currentTarget.value)}
					data-testid="question-body"
				/>
				{mutation.error && <ErrorNotice error={mutation.error} />}
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onDone}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						disabled={!subject.trim() || !body.trim()}
						loading={mutation.isPending}
						onClick={() =>
							mutation.mutate(
								{ body: { body, subject } },
								{ onSuccess: onDone },
							)
						}
						data-testid="question-send"
					>
						<Trans>Send</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
