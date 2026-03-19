import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Box, Collapse, Divider, Group, Text, Tooltip } from "@mantine/core";
import { IconArrowUpRight, IconNotes } from "@tabler/icons-react";
import { formatDate } from "date-fns";
import { BookmarkSimple } from "@phosphor-icons/react";
import type React from "react";
import { Children, useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import { useParams } from "react-router";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { MODE_COLORS } from "@/components/chat/ChatModeSelector";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { Markdown } from "@/components/common/Markdown";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import { ENABLE_CHAT_AUTO_SELECT } from "@/config";
import { cn } from "@/lib/utils";
import { ReferencesIconButton } from "../common/ReferencesIconButton";
import { extractMessageMetadata } from "./chatUtils";
import { References } from "./References";
import { Sources } from "./Sources";
import SourcesSearched from "./SourcesSearched";

type ChatMode = "overview" | "deep_dive" | "agentic" | null;

const isAgenticTranscriptHref = (href?: string) =>
	typeof href === "string" && href.includes("/transcript");

const getLinkLabel = (children: React.ReactNode) => {
	const text = Children.toArray(children)
		.map((child) => {
			if (typeof child === "string" || typeof child === "number") {
				return String(child);
			}
			return "";
		})
		.join("")
		.trim();

	return text || t`Transcript`;
};

export const ChatHistoryMessage = ({
	message,
	section,
	referenceIds,
	setReferenceIds,
	chatMode,
	onSaveAsTemplate,
}: {
	message: ChatHistory[number];
	section?: React.ReactNode;
	referenceIds?: string[];
	setReferenceIds?: (ids: string[]) => void;
	chatMode?: ChatMode;
	onSaveAsTemplate?: (content: string) => void;
}) => {
	const [metadata, setMetadata] = useState<ChatHistoryMessage["metadata"]>([]);
	const { projectId } = useParams();

	useEffect(() => {
		const flattenedItems = extractMessageMetadata(message);
		setMetadata(flattenedItems);
	}, [message]);

	const markdownComponents = useMemo<Components | undefined>(() => {
		if (chatMode !== "agentic") return undefined;

		return {
			a({ children, className, href, ...props }) {
				if (!isAgenticTranscriptHref(href)) {
					return (
						<a
							href={href}
							className={cn(
								"text-[var(--mantine-color-anchor)] underline underline-offset-2 transition-colors hover:text-[var(--mantine-color-blue-7)]",
								className,
							)}
							{...props}
						>
							{children}
						</a>
					);
				}

				return (
					<Tooltip label={<Trans>Open transcript</Trans>}>
						<a
							href={href}
							className={cn(
								"not-prose inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50/90 px-2 py-0.5 text-[11px] font-medium text-sky-700 no-underline transition-all hover:-translate-y-px hover:border-sky-300 hover:bg-white hover:text-sky-800",
								className,
							)}
							aria-label={t`Open transcript`}
							data-testid="agentic-transcript-link"
							title={t`Open transcript`}
							{...props}
						>
							<IconNotes size={12} stroke={1.9} />
							<span>{getLinkLabel(children)}</span>
							<IconArrowUpRight size={11} stroke={1.9} />
						</a>
					</Tooltip>
				);
			},
		};
	}, [chatMode]);

	const isSelected = referenceIds?.includes(message.id) ?? false;

	if (message.role === "system") {
		return null;
	}

	if (["user", "assistant"].includes(message.role)) {
		return (
			<>
				{ENABLE_CHAT_AUTO_SELECT &&
					metadata?.length > 0 &&
					metadata?.some((item) => item.type === "reference") && (
						<div className="mb-3">
							<Sources metadata={metadata} projectId={projectId} />
						</div>
					)}
				{message?.metadata?.some(
					(metadata) => metadata.type === "reference",
				) && (
					<div className="mb-3">
						<Sources metadata={message.metadata} projectId={projectId} />
					</div>
				)}

				{message.content && (
					<ChatMessage
						key={message.id}
						role={message.role}
						chatMode={chatMode}
						section={
							<Group w="100%" gap="lg">
								<Text className={cn("italic")} size="xs" c="gray.7">
									{formatDate(
										// @ts-expect-error message is not typed
										new Date(message.createdAt ?? new Date()),
										"MMM d, h:mm a",
									)}
								</Text>
								<Group gap="sm">
									<CopyRichTextIconButton markdown={message.content} />
									{message.role === "user" && onSaveAsTemplate && (
										<Tooltip label={t`Save as template`}>
											<ActionIcon
												size="xs"
												variant="subtle"
												color="gray"
												onClick={() => onSaveAsTemplate(message.content)}
											>
												<BookmarkSimple size={14} />
											</ActionIcon>
										</Tooltip>
									)}

									{/* Info button for citations */}
									{ENABLE_CHAT_AUTO_SELECT &&
										metadata?.length > 0 &&
										metadata?.some((item) => item.type === "citation") && (
											<ReferencesIconButton
												showCitations={isSelected}
												setShowCitations={(show) => {
													if (setReferenceIds) {
														setReferenceIds(
															show
																? [...(referenceIds || []), message.id]
																: (referenceIds || []).filter(
																		(id) => id !== message.id,
																	),
														);
													}
												}}
											/>
										)}
									{message?.metadata?.length > 0 &&
										message?.metadata?.some(
											(item) => item.type === "citation",
										) && (
											<ReferencesIconButton
												showCitations={isSelected}
												setShowCitations={(show) => {
													if (setReferenceIds) {
														setReferenceIds(
															show
																? [...(referenceIds || []), message.id]
																: (referenceIds || []).filter(
																		(id) => id !== message.id,
																	),
														);
													}
												}}
											/>
										)}
								</Group>
							</Group>
						}
					>
						<Markdown
							className="prose-sm"
							content={message.content}
							components={markdownComponents}
						/>

						{/* Show citations inside the chat bubble when toggled */}
						<Collapse in={isSelected} transitionDuration={200}>
							<Divider className="my-7" />
							<div className="my-3">
								{ENABLE_CHAT_AUTO_SELECT &&
									metadata.length > 0 &&
									metadata.some((item) => item.type === "citation") && (
										<References metadata={metadata} projectId={projectId} />
									)}
								{message?.metadata?.length > 0 &&
									message?.metadata?.some(
										(item) => item.type === "citation",
									) && (
										<References
											metadata={message.metadata}
											projectId={projectId}
										/>
									)}
							</div>
						</Collapse>
					</ChatMessage>
				)}
			</>
		);
	}

	if (message.role === "dembrane") {
		if (message.content === "searched") {
			return (
				<Box className="flex justify-start">
					<SourcesSearched />
				</Box>
			);
		}
	}
	if (message?._original?.added_conversations?.length > 0) {
		const conversations = message?._original?.added_conversations
			.map((conv: string | ProjectChatMessageConversation1) =>
				typeof conv === "object" && conv !== null
					? (conv as ProjectChatMessageConversation1).conversation_id
					: null,
			)
			.filter((conv) => conv != null);
		return conversations.length > 0 ? (
			// biome-ignore lint/a11y/useValidAriaRole: role is a component prop for styling, not an ARIA attribute
			<ChatMessage key={message.id} role="dembrane" section={section}>
				<Group gap="xs" align="baseline">
					<Text size="xs" c="dimmed" fw={500}>
						<Trans>Context added:</Trans>
					</Text>
					<ConversationLinks
						conversations={conversations as unknown as Conversation[]}
						color="var(--app-text)"
						hoverUnderlineColor={MODE_COLORS.deep_dive.primary}
					/>
				</Group>
			</ChatMessage>
		) : null;
	}

	return null;
};
