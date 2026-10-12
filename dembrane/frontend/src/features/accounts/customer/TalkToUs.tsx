import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	SimpleGrid,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { CalendarBlankIcon, ChatTextIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import type { TicketT } from "../contract/contract.gen";
import { PageSection } from "./PageSection";
import { AskForm, TicketItem } from "./Questions";

/**
 * Two ways to reach dembrane, side by side as equals: a written question, answered here,
 * or a call. Earlier questions follow, newest first as the API sends them.
 */
export function TalkToUs({
	orgId,
	tickets,
	onBookCall,
}: {
	orgId: string;
	tickets: TicketT[];
	/** Absent while booking a call is itself a step in To do. */
	onBookCall?: () => void;
}) {
	const [asking, setAsking] = useState(false);
	return (
		<PageSection title={<Trans>Talk to us</Trans>} testId="questions">
			<Stack gap="md">
				{asking ? (
					<AskForm
						orgId={orgId}
						side="customer"
						onDone={() => setAsking(false)}
					/>
				) : (
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
						<Choice
							icon={<ChatTextIcon size={20} aria-hidden />}
							title={<Trans>Ask a question</Trans>}
							body={<Trans>Our answer appears here, on this page.</Trans>}
							onClick={() => setAsking(true)}
							testId="ask-question"
						/>
						{onBookCall && (
							<Choice
								icon={<CalendarBlankIcon size={20} aria-hidden />}
								title={<Trans>Book a call</Trans>}
								body={<Trans>Pick a time that suits you.</Trans>}
								onClick={onBookCall}
								testId="book-call"
							/>
						)}
					</SimpleGrid>
				)}
				{tickets.length > 0 && (
					<Accordion variant="separated" radius={0} chevronPosition="right">
						{tickets.map((ticket) => (
							<TicketItem
								key={ticket.id}
								ticket={ticket}
								orgId={orgId}
								side="customer"
							/>
						))}
					</Accordion>
				)}
			</Stack>
		</PageSection>
	);
}

function Choice({
	icon,
	title,
	body,
	onClick,
	testId,
}: {
	icon: ReactNode;
	title: ReactNode;
	body: ReactNode;
	onClick: () => void;
	testId: string;
}) {
	return (
		<UnstyledButton
			className="app-do"
			p="md"
			onClick={onClick}
			data-testid={testId}
		>
			<Stack gap="xs">
				<Text c="var(--app-action)" style={{ lineHeight: 0 }}>
					{icon}
				</Text>
				<Text>{title}</Text>
				<Text size="sm" c="dimmed">
					{body}
				</Text>
			</Stack>
		</UnstyledButton>
	);
}
