import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Drawer,
	Group,
	Pagination,
	Select,
	Stack,
	Table,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import {
	ArrowSquareOut,
	ArrowsClockwise,
	CaretLeft,
	CaretRight,
	ThumbsDown,
	ThumbsUp,
} from "@phosphor-icons/react";
import { endOfDay, formatDate, formatDistanceToNow } from "date-fns";
import type React from "react";
import { useState } from "react";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Markdown } from "@/components/common/Markdown";
import {
	type AdminResponseFeedbackRow,
	type FeedbackRating,
	useAdminResponseFeedback,
} from "./hooks";
import { REASON_KEYS, type ReasonKey, reasonLabel } from "./reasons";

const PAGE_SIZE = 50;

type ChatMode = "overview" | "deep_dive" | "agentic";

const chatModeLabel = (mode: string | null | undefined): string => {
	switch (mode) {
		case "overview":
			return t`Overview`;
		case "deep_dive":
			return t`Deep Dive`;
		case "agentic":
			return t`Agentic`;
		default:
			return mode ?? "";
	}
};

const RatingIcon = ({ rating }: { rating: FeedbackRating }) =>
	rating === "up" ? (
		<ThumbsUp size={16} weight="fill" color="var(--mantine-color-primary-6)" />
	) : (
		<ThumbsDown
			size={16}
			weight="fill"
			color="var(--mantine-color-primary-6)"
		/>
	);

export const AdminResponseFeedbackPanel = () => {
	const [page, setPage] = useState(1);
	const [rating, setRating] = useState<FeedbackRating | undefined>();
	const [reason, setReason] = useState<ReasonKey | undefined>();
	const [chatMode, setChatMode] = useState<ChatMode | undefined>();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([
		null,
		null,
	]);
	const query = useAdminResponseFeedback({
		chatMode,
		dateFrom: dateRange[0]?.toISOString(),
		dateTo: dateRange[1] ? endOfDay(dateRange[1]).toISOString() : undefined,
		limit: PAGE_SIZE,
		page,
		rating,
		reason,
		targetType: "chat_message",
	});
	const items = query.data?.items ?? [];
	const total = query.data?.total ?? 0;
	const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
	const rangeEnd = Math.min(page * PAGE_SIZE, total);
	const selectedIndex = items.findIndex((row) => row.id === selectedId);
	const selected = selectedIndex >= 0 ? items[selectedIndex] : null;
	const step = (delta: number) => {
		const next = items[selectedIndex + delta];
		if (next) setSelectedId(next.id);
	};

	return (
		<Stack gap="md">
			<Group gap="sm">
				<Select
					size="sm"
					clearable
					placeholder={t`Rating`}
					data={[
						{ label: t`Thumbs up`, value: "up" },
						{ label: t`Thumbs down`, value: "down" },
					]}
					value={rating ?? null}
					onChange={(v) => {
						setRating((v as FeedbackRating) ?? undefined);
						setPage(1);
					}}
				/>
				<Select
					size="sm"
					clearable
					placeholder={t`Reason`}
					data={REASON_KEYS.map((key) => ({
						label: reasonLabel(key),
						value: key,
					}))}
					value={reason ?? null}
					onChange={(v) => {
						setReason((v as ReasonKey) ?? undefined);
						setPage(1);
					}}
				/>
				<Select
					size="sm"
					clearable
					placeholder={t`Mode`}
					data={(["deep_dive", "agentic"] as ChatMode[]).map((mode) => ({
						label: chatModeLabel(mode),
						value: mode,
					}))}
					value={chatMode ?? null}
					onChange={(v) => {
						setChatMode((v as ChatMode) ?? undefined);
						setPage(1);
					}}
				/>
				<DatePickerInput
					size="sm"
					clearable
					type="range"
					placeholder={t`Date range`}
					value={dateRange}
					onChange={(value) => {
						setDateRange(value);
						setPage(1);
					}}
				/>
				<Button
					variant="subtle"
					size="sm"
					leftSection={<ArrowsClockwise size={14} />}
					onClick={() => query.refetch()}
				>
					<Trans>Refresh</Trans>
				</Button>
			</Group>
			<Table.ScrollContainer minWidth={900}>
				<Table highlightOnHover verticalSpacing="md">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Date</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Rating</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Question</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Organisation</Trans>
							</Table.Th>
							<Table.Th />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{items.map((row) => {
							const isSelected = selectedId === row.id;
							const created = row.date_created
								? new Date(row.date_created)
								: null;
							return (
								<Table.Tr
									key={row.id}
									onClick={() => setSelectedId(row.id)}
									style={{ cursor: "pointer" }}
									aria-selected={isSelected}
									bg={isSelected ? "var(--mantine-color-primary-0)" : undefined}
									data-testid={`response-feedback-row-${row.id}`}
								>
									<Table.Td>
										<Tooltip
											label={
												created ? formatDate(created, "MMM d yyyy, HH:mm") : ""
											}
										>
											<Text size="sm" style={{ whiteSpace: "nowrap" }}>
												{created
													? formatDistanceToNow(created, { addSuffix: true })
													: ""}
											</Text>
										</Tooltip>
									</Table.Td>
									<Table.Td>
										<Group gap="xs" wrap="nowrap">
											<RatingIcon rating={row.rating} />
											{row.reasons.map((key) => (
												<Badge
													key={key}
													size="sm"
													variant="outline"
													color="primary"
												>
													{reasonLabel(key)}
												</Badge>
											))}
										</Group>
									</Table.Td>
									<Table.Td style={{ maxWidth: 420 }}>
										<Text size="sm" lineClamp={1}>
											{row.context.prompt ?? ""}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm">{row.org_name ?? ""}</Text>
										<Text size="xs">
											{[scopeOf(row), hostOf(row)].filter(Boolean).join(" · ")}
										</Text>
									</Table.Td>
									<Table.Td>
										<Button
											variant="subtle"
											size="xs"
											onClick={(event) => {
												event.stopPropagation();
												setSelectedId(row.id);
											}}
											data-testid={`response-feedback-open-${row.id}`}
										>
											<Trans>Show more</Trans>
										</Button>
									</Table.Td>
								</Table.Tr>
							);
						})}
					</Table.Tbody>
				</Table>
			</Table.ScrollContainer>
			{items.length === 0 && !query.isLoading && (
				<Text size="sm">
					<Trans>No feedback yet.</Trans>
				</Text>
			)}
			<Group justify="space-between">
				<Text size="sm" data-testid="response-feedback-range">
					{total > 0 ? (
						<Trans>
							Showing {rangeStart}-{rangeEnd} of {total}
						</Trans>
					) : null}
				</Text>
				<Pagination
					value={page}
					onChange={setPage}
					total={Math.max(1, Math.ceil(total / PAGE_SIZE))}
				/>
			</Group>
			<Drawer.Root
				opened={selected !== null}
				onClose={() => setSelectedId(null)}
				position="right"
				size="lg"
				padding="xl"
			>
				<Drawer.Overlay />
				<Drawer.Content data-testid="response-feedback-drawer">
					<Drawer.Header>
						<Drawer.Title>
							<Stack gap={4}>
								<Title order={4}>
									<Trans>Response feedback</Trans>
								</Title>
								{selected ? (
									<Group gap="sm" wrap="nowrap">
										<RatingIcon rating={selected.rating} />
										{selected.reasons.map((key) => (
											<Badge
												key={key}
												size="sm"
												variant="outline"
												color="primary"
											>
												{reasonLabel(key)}
											</Badge>
										))}
										<Text size="sm">
											{selected.date_created
												? formatDate(
														new Date(selected.date_created),
														"MMM d yyyy, HH:mm",
													)
												: ""}
										</Text>
									</Group>
								) : null}
							</Stack>
						</Drawer.Title>
						<Group gap="xs" wrap="nowrap">
							<ActionIcon
								variant="subtle"
								disabled={selectedIndex <= 0}
								onClick={() => step(-1)}
								aria-label={t`Previous`}
								data-testid="response-feedback-previous"
							>
								<CaretLeft size={16} />
							</ActionIcon>
							<ActionIcon
								variant="subtle"
								disabled={selectedIndex >= items.length - 1}
								onClick={() => step(1)}
								aria-label={t`Next`}
								data-testid="response-feedback-next"
							>
								<CaretRight size={16} />
							</ActionIcon>
							<Drawer.CloseButton />
						</Group>
					</Drawer.Header>
					<Drawer.Body>
						{selected ? <FeedbackDetail row={selected} /> : null}
					</Drawer.Body>
				</Drawer.Content>
			</Drawer.Root>
		</Stack>
	);
};

const scopeOf = (row: AdminResponseFeedbackRow) =>
	[row.workspace_name, row.project_name].filter(Boolean).join(" / ");

const hostOf = (row: AdminResponseFeedbackRow) =>
	row.user_name ?? (row.user_email ? row.user_email.split("@")[1] : "");

const metaCellStyle = (index: number): React.CSSProperties => ({
	borderBottom: index < 3 ? "1px solid var(--mantine-color-gray-3)" : "none",
	borderRight:
		index % 3 === 2 ? "none" : "1px solid var(--mantine-color-gray-3)",
	padding: "var(--mantine-spacing-sm) var(--mantine-spacing-md)",
});

const MetaGrid = ({ row }: { row: AdminResponseFeedbackRow }) => {
	const cells: { label: string; value: React.ReactNode }[] = [
		{ label: t`Mode`, value: chatModeLabel(row.context.chat_mode) },
		{ label: t`Organisation`, value: row.org_name },
		{ label: t`Workspace / Project`, value: scopeOf(row) },
		{ label: t`Host`, value: row.user_name },
		{ label: t`Email`, value: row.user_email },
		{
			label: t`Replay`,
			value: row.context.session_replay_url ? (
				<Anchor
					href={row.context.session_replay_url}
					target="_blank"
					rel="noreferrer"
					size="xs"
				>
					<Group gap={4} wrap="nowrap" component="span">
						<Trans>Open replay</Trans>
						<ArrowSquareOut size={12} />
					</Group>
				</Anchor>
			) : null,
		},
	];
	return (
		<Box
			style={{
				border: "1px solid var(--mantine-color-gray-3)",
				borderRadius: "var(--mantine-radius-default)",
				display: "grid",
				gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
			}}
			data-testid="response-feedback-metadata"
		>
			{cells.map((cell, index) => (
				<Box key={cell.label} style={metaCellStyle(index)}>
					<Text size="xs" tt="uppercase">
						{cell.label}
					</Text>
					{typeof cell.value === "string" || cell.value == null ? (
						<Text size="xs" style={{ overflowWrap: "anywhere" }}>
							{cell.value ?? ""}
						</Text>
					) : (
						cell.value
					)}
				</Box>
			))}
		</Box>
	);
};

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
	<Text size="xs" tt="uppercase">
		{children}
	</Text>
);

const quoteStyle: React.CSSProperties = {
	border: "1px solid var(--mantine-color-gray-3)",
	borderRadius: "var(--mantine-radius-default)",
	padding: "var(--mantine-spacing-sm) var(--mantine-spacing-md)",
	whiteSpace: "pre-wrap",
};

const asChatMode = (mode: string | null | undefined): ChatMode | null =>
	mode === "overview" || mode === "deep_dive" || mode === "agentic"
		? mode
		: null;

// `role` here is the speaker; a const keeps Biome's ARIA rule quiet.
const SPEAKER = { assistant: "assistant", host: "user" } as const;

const FeedbackDetail = ({ row }: { row: AdminResponseFeedbackRow }) => {
	const chatMode = asChatMode(row.context.chat_mode);
	return (
		<Stack gap="xl" pt="sm">
			<MetaGrid row={row} />
			{row.comment ? (
				<Stack gap="xs" data-testid={`response-feedback-comment-${row.id}`}>
					<SectionLabel>
						<Trans>Host's feedback</Trans>
					</SectionLabel>
					<Text size="sm" style={quoteStyle}>
						{row.comment}
					</Text>
				</Stack>
			) : null}
			<Stack gap="xs">
				<SectionLabel>
					<Trans>Conversation</Trans>
				</SectionLabel>
				<Stack gap="md" data-testid="response-feedback-exchange">
					{row.context.prompt ? (
						<ChatMessage role={SPEAKER.host} chatMode={chatMode}>
							<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
								{row.context.prompt}
							</Text>
						</ChatMessage>
					) : null}
					<ChatMessage role={SPEAKER.assistant} chatMode={chatMode}>
						<Markdown
							className="prose-sm"
							content={row.response_snapshot ?? ""}
						/>
					</ChatMessage>
				</Stack>
			</Stack>
		</Stack>
	);
};
