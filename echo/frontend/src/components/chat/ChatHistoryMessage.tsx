import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Collapse,
	Divider,
	Group,
	Modal,
	SimpleGrid,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { BookmarkSimple } from "@phosphor-icons/react";
import {
	IconArrowUpRight,
	IconFileText,
	IconMessages,
} from "@tabler/icons-react";
import { formatDate } from "date-fns";
import type React from "react";
import { Children, useMemo } from "react";
import type { Components } from "react-markdown";
import { useParams } from "react-router";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { MODE_COLORS } from "@/components/chat/ChatModeSelector";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { Markdown } from "@/components/common/Markdown";
import { QRCode } from "@/components/common/QRCode";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import { PARTICIPANT_BASE_URL } from "@/config";
import { cn } from "@/lib/utils";
import { ReferencesIconButton } from "../common/ReferencesIconButton";
import { References } from "./References";
import { Sources } from "./Sources";
import SourcesSearched from "./SourcesSearched";

type ChatMode = "overview" | "deep_dive" | "agentic" | null;

const isAgenticTranscriptHref = (href?: string) =>
	typeof href === "string" &&
	(href.includes("/conversations/") || href.includes("/transcript"));

const isDocsHref = (href?: string) => {
	if (typeof href !== "string") return false;
	try {
		const { hostname } = new URL(href);
		return (
			hostname === "docs.dembrane.com" ||
			(hostname.startsWith("docs.") && hostname.endsWith(".dembrane.com"))
		);
	} catch {
		return false;
	}
};

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

// One readable link style for everything the agent cites: underlined text
// with a small external-arrow, never a pill.
const AGENTIC_LINK_CLASSES =
	"not-prose inline-flex items-baseline gap-0.5 text-[var(--mantine-color-anchor)] underline underline-offset-2 transition-colors hover:text-[var(--mantine-color-blue-7)]";

const URL_PATTERN = /https?:\/\/[^\s<>)\]]+/g;

function ownPortalStartLink(content: string, projectId?: string): string | null {
	if (!projectId) return null;
	const portal = new URL(PARTICIPANT_BASE_URL);
	const matches = content.match(URL_PATTERN) ?? [];
	for (const match of matches) {
		try {
			const candidate = new URL(match.replace(/[.,;:!?]+$/, ""));
			if (candidate.origin !== portal.origin) continue;
			const segments = candidate.pathname.split("/").filter(Boolean);
			if (
				segments.length >= 3 &&
				segments[1] === projectId &&
				segments[2] === "start"
			) {
				return candidate.toString();
			}
		} catch {
			continue;
		}
	}
	return null;
}

const DocsChoiceCard = ({
	description,
	href,
	icon,
	title,
}: {
	description: React.ReactNode;
	href: string;
	icon: React.ReactNode;
	title: React.ReactNode;
}) => (
	<a
		href={href}
		target="_blank"
		rel="noreferrer"
		className="block cursor-pointer rounded-xl border-2 border-gray-300 bg-white p-6 no-underline transition-all hover:border-[var(--mantine-color-primary-4)] hover:bg-[var(--mantine-color-primary-0)]"
	>
		<Stack gap="sm" align="center" className="justify-center py-2 text-center">
			<Group gap="sm" align="center">
				{icon}
				<Title order={4} fw={600}>
					{title}
				</Title>
				<IconArrowUpRight size={18} stroke={1.9} />
			</Group>
			<Text size="sm">{description}</Text>
		</Stack>
	</a>
);

/** A documentation citation. Clicking opens a small chooser: the cited page,
 * or the documentation for the feature the host is using (Ask). Both open in
 * a new tab. */
const AgenticDocsLink = ({
	children,
	href,
}: {
	children: React.ReactNode;
	href: string;
}) => {
	const [opened, { open, close }] = useDisclosure(false);
	const chatDocsHref = (() => {
		try {
			return `${new URL(href).origin}/users/host/chat-and-ask.html`;
		} catch {
			return href;
		}
	})();

	return (
		<>
			<a
				href={href}
				className={AGENTIC_LINK_CLASSES}
				data-testid="agentic-docs-link"
				onClick={(event) => {
					event.preventDefault();
					open();
				}}
			>
				<span>{getLinkLabel(children)}</span>
				<IconArrowUpRight size={12} stroke={1.9} className="self-center" />
			</a>
			<Modal
				opened={opened}
				onClose={close}
				centered
				size="lg"
				title={<Trans>Documentation</Trans>}
			>
				<SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
					<DocsChoiceCard
						href={href}
						icon={<IconFileText size={28} stroke={1.7} />}
						title={<Trans>Open documentation</Trans>}
						description={<Trans>The page this answer refers to.</Trans>}
					/>
					<DocsChoiceCard
						href={chatDocsHref}
						icon={<IconMessages size={28} stroke={1.7} />}
						title={<Trans>Open chat documentation</Trans>}
						description={<Trans>How Ask works and what it can do.</Trans>}
					/>
				</SimpleGrid>
			</Modal>
		</>
	);
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
	const { projectId } = useParams();
	const portalStartLink =
		message.role === "assistant"
			? ownPortalStartLink(message.content, projectId)
			: null;

	const markdownComponents = useMemo<Components | undefined>(() => {
		if (chatMode !== "agentic") return undefined;

		return {
			a({ children, className, href, ...props }) {
				if (isDocsHref(href)) {
					return (
						<AgenticDocsLink href={href ?? ""}>{children}</AgenticDocsLink>
					);
				}

				if (isAgenticTranscriptHref(href)) {
					return (
						<Tooltip label={<Trans>Open transcript</Trans>}>
							<a
								href={href}
								className={cn(AGENTIC_LINK_CLASSES, className)}
								aria-label={t`Open transcript`}
								data-testid="agentic-transcript-link"
								{...props}
							>
								<span>{getLinkLabel(children)}</span>
								<IconArrowUpRight
									size={12}
									stroke={1.9}
									className="self-center"
								/>
							</a>
						</Tooltip>
					);
				}

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
						{portalStartLink ? (
							<Box
								mt="sm"
								className="w-fit rounded-md bg-white p-2"
								data-testid="assistant-portal-link-qr"
							>
								<QRCode
									value={portalStartLink}
									href={portalStartLink}
									className="h-24 w-24"
								/>
							</Box>
						) : null}

						{/* Show citations inside the chat bubble when toggled */}
						<Collapse in={isSelected} transitionDuration={200}>
							<Divider className="my-7" />
							<div className="my-3">
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
