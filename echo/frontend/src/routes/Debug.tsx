import {
	Button,
	Divider,
	Group,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";

import type { Cell, Row } from "@tanstack/react-table";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { useProjectChats } from "@/components/chat/hooks";
import { toast } from "@/components/common/Toaster";
import { useConversationById } from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
import {
	ADMIN_BASE_URL,
	API_BASE_URL,
	BUILD_VERSION,
	DIRECTUS_CONTENT_PUBLIC_URL,
	DIRECTUS_PUBLIC_URL,
	ENABLE_CHAT_AUTO_SELECT,
	PARTICIPANT_BASE_URL,
	SUPPORTED_LANGUAGES,
} from "@/config";

interface ProcessingStatus {
	id: string;
	timestamp: string;
	event?: string | null;
	item_id?: string;
	collection_name?: string;
	duration_ms?: number | null;
	message?: string | null;
	json?: any;
	subRows?: ProcessingStatus[];
}

// Row renderer component for handling the recursive rendering of rows
// biome-ignore lint/correctness/noUnusedVariables: false positive
function TableRowRenderer({
	row,
	flexRender,
	columns,
}: {
	row: Row<ProcessingStatus>;
	flexRender: any;
	columns: any[];
}) {
	// More detailed debugging information

	// Check if this is a parent row with expanded children
	const isChildRow = row.depth > 0;

	// Styling for different row types
	const getRowStyle = () => {
		if (row.getIsGrouped()) {
			return {
				background: "#f9f9f9",
				borderBottom: row.getIsExpanded() ? "1px solid #ddd" : "2px solid #ddd",
				borderTop: "2px solid #ddd",
			};
		} else if (isChildRow) {
			return {
				background: "#f0ffff",
				borderLeft: "3px solid #bcd",
			};
		}
		return {};
	};

	return (
		<>
			<tr style={getRowStyle()}>
				{row
					.getVisibleCells()
					.map((cell: Cell<ProcessingStatus, any>, cellIndex: number) => (
						<td
							key={cell.id}
							style={{
								background: cell.getIsGrouped()
									? "#f0f8ff"
									: cell.getIsAggregated()
										? "#f5f5f5"
										: cell.getIsPlaceholder()
											? "#fafafa"
											: undefined,
								// Add a subtle left border to all cells in a child row
								borderLeft:
									isChildRow && cellIndex > 0 ? "1px solid #eee" : undefined,
								fontWeight: cell.getIsGrouped() ? "bold" : undefined,
								// Add left padding to the first cell of child rows to create visual hierarchy
								paddingLeft:
									isChildRow && cellIndex === 0
										? `${row.depth * 20}px`
										: undefined,
							}}
						>
							{/* Cell in a grouping column */}
							{cell.getIsGrouped() && (
								<>
									<Button
										size="xs"
										mr={2}
										onClick={(e) => {
											e.stopPropagation();
											row.getToggleExpandedHandler()();
										}}
										variant="subtle"
										color={row.getIsExpanded() ? "blue" : "gray"}
										style={{
											boxShadow: row.getIsExpanded()
												? "0 0 2px rgba(0,0,0,0.2)"
												: "none",
											transition: "all 0.2s",
										}}
									>
										{row.getIsExpanded() ? "👇" : "👉"}
										{row.subRows?.length > 0 && (
											<Text size="xs" span ml={4}>
												({row.subRows.length})
											</Text>
										)}
									</Button>
									{flexRender(
										cell.column.columnDef.aggregatedCell ??
											cell.column.columnDef.cell,
										cell.getContext(),
									)}{" "}
									({row.subRows?.length ?? 0})
								</>
							)}

							{/* Aggregated cell in a group row (but not the grouping column itself) */}
							{/* Also handles normal cells if they are not grouped, not placeholder */}
							{!cell.getIsGrouped() &&
								!cell.getIsPlaceholder() &&
								flexRender(cell.column.columnDef.cell, cell.getContext())}

							{/* Placeholder cell (rendered if not grouped and no other content applies) */}
							{cell.getIsPlaceholder() && !cell.getIsGrouped() && (
								<span>-</span> // Show a dash for placeholders
							)}
						</td>
					))}
			</tr>

			{/* Recursively render subrows if this row is expanded */}
			{row.getIsExpanded() && row.subRows && row.subRows.length > 0 && (
				<>
					{row.subRows.map((subRow: Row<ProcessingStatus>) => (
						<TableRowRenderer
							key={subRow.id}
							row={subRow}
							flexRender={flexRender}
							columns={columns}
						/>
					))}
					{/* Visual divider after subrows */}
					<tr style={{ background: "#f0f0f0", height: "4px" }}>
						<td colSpan={columns.length} />
					</tr>
				</>
			)}
		</>
	);
}

export default function DebugPage() {
	const ref = useRef<number>(0);
	const handleTestToast = () => {
		if (ref.current === 0) {
			toast.success("Test toast");
		} else if (ref.current === 1) {
			toast.error("Test toast");
		} else if (ref.current === 2) {
			toast.warning("Test toast");
		} else if (ref.current === 3) {
			toast.info("Test toast");
		} else if (ref.current === 4) {
			toast.error("Test toast");
		} else {
			toast("Test toast");
		}

		ref.current++;
	};

	const { projectId, conversationId, chatId } = useParams();

	const [currentProjectId, setCurrentProjectId] = useState<string | null>(
		projectId ?? null,
	);
	const [currentConversationId, setCurrentConversationId] = useState<
		string | null
	>(conversationId ?? null);

	const [currentChatId, setCurrentChatId] = useState<string | null>(
		chatId ?? null,
	);

	const { data: user } = useCurrentUser();

	const { data: project } = useProjectById({
		projectId: currentProjectId ?? "",
	});

	const { data: conversation } = useConversationById({
		conversationId: currentConversationId ?? "",
		loadConversationChunks: true,
		query: {
			fields: [
				"*",
				"processing_status.*" as any,
				{
					tags: [
						{
							project_tag_id: ["id", "text", "created_at"],
						},
					],
				},
				{ chunks: ["*", "processing_status.*"] as any },
			],
		},
	});

	const { data: chats } = useProjectChats(currentProjectId ?? "", {
		filter: {
			"count(project_chat_messages)": {
				_gt: 0,
			},
			project_id: {
				_eq: currentProjectId,
			},
		},
	});

	const variables = {
		BUILD_VERSION,
		DEBUG_MODE: true,
		ff: {
			ENABLE_CHAT_AUTO_SELECT,
			SUPPORTED_LANGUAGES,
		},
		urls: {
			ADMIN_BASE_URL,
			API_BASE_URL,
			DIRECTUS_CONTENT_PUBLIC_URL,
			DIRECTUS_PUBLIC_URL,
			PARTICIPANT_BASE_URL,
		},
	};

	return (
		<Stack className="p-8">
			<Stack>
				<Title order={1}>Debug</Title>
				<Group>
					<TextInput
						label="Project ID"
						value={currentProjectId ?? ""}
						onChange={(e) => setCurrentProjectId(e.target.value)}
					/>
					<TextInput
						label="Conversation ID"
						value={currentConversationId ?? ""}
						onChange={(e) => setCurrentConversationId(e.target.value)}
					/>
					<TextInput
						label="Chat ID"
						value={currentChatId ?? ""}
						onChange={(e) => setCurrentChatId(e.target.value)}
					/>
				</Group>
				<Stack>
					<pre>{JSON.stringify(variables, null, 2)}</pre>
				</Stack>
				<div>
					<Button onClick={handleTestToast}>Test Toast</Button>
				</div>
			</Stack>
			<Divider />
			<Stack>
				<Title order={1}>User</Title>
				<pre>{JSON.stringify(user, null, 2)}</pre>
			</Stack>
			<Stack>
				<Title order={1}>Project</Title>
				<pre>{JSON.stringify(project, null, 2)}</pre>
			</Stack>
			<Divider />
			<Stack>
				<Title order={1}>Conversation</Title>
				<pre>{JSON.stringify(conversation, null, 2)}</pre>
				{/* <Group>
          <Title order={3}>Logs</Title>
          <Button onClick={() => refetchConversationProcessingStatus()}>
            Refetch Logs
          </Button>
        </Group>
        <LogTable data={conversationProcessingStatus ?? []} /> */}
			</Stack>
			<Divider />
			<Stack>
				<Title order={1}>Chats</Title>
				<pre>{JSON.stringify(chats, null, 2)}</pre>
			</Stack>
		</Stack>
	);
}
