import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Text } from "@mantine/core";
import { ChatCircleText as ChatCircleTextIcon } from "@phosphor-icons/react";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import { testId } from "@/lib/testUtils";

/** The one owner of composer appearance. Every chat surface renders through
 * this so the three bottom bars cannot drift apart again. */
export const ChatComposerShell = ({
	children,
	chips,
	footerLeft,
	footerRight,
}: {
	children: React.ReactNode;
	chips?: React.ReactNode;
	footerLeft?: React.ReactNode;
	footerRight?: React.ReactNode;
}) => (
	<Box
		className="rounded-xl border px-3 pb-2 pt-2 shadow-sm transition-colors"
		style={{
			backgroundColor: "var(--app-background)",
			borderColor: "var(--mantine-color-primary-light)",
		}}
	>
		{chips && <Box {...testId("chat-composer-chips")}>{chips}</Box>}
		{children}
		<Group justify="space-between" align="center" gap="xs">
			<Group gap="xs">{footerLeft}</Group>
			<Group gap="xs" wrap="nowrap">
				{footerRight}
			</Group>
		</Group>
	</Box>
);

export const ConversationFocusChips = ({
	conversations,
	count,
	disabled,
	isClearing,
	label,
	onClearAll,
	overflowNotice,
}: {
	/** Omit if only a count is known (e.g. before the chat exists); use `count`. */
	conversations?: Array<{ id: string; participant_name?: string | null }>;
	/** Count-only mode: same shell, no `ConversationLinks`. */
	count?: number;
	/** Disables "Clear all" for reasons unrelated to clearing (unlike
	 * `isClearing`, which is the clear action's own loading state). */
	disabled?: boolean;
	isClearing?: boolean;
	label: React.ReactNode;
	/** Absent means this surface has no way to clear, so no control renders.
	 * Never wire this to something that opens a picker; "Clear all" must clear. */
	onClearAll?: () => void;
	overflowNotice?: React.ReactNode;
}) => {
	const resolvedCount = conversations ? conversations.length : (count ?? 0);
	if (resolvedCount === 0) return null;
	return (
		<Group
			gap="xs"
			align="baseline"
			wrap="wrap"
			className="mb-2 border-0 border-b border-solid pb-2 italic"
			style={{ borderColor: "var(--mantine-color-primary-light)" }}
		>
			<Text size="xs" fw={500}>
				{label}
			</Text>
			{overflowNotice ? (
				<Text size="xs">{overflowNotice}</Text>
			) : conversations ? (
				<ConversationLinks
					conversations={
						conversations as unknown as Parameters<
							typeof ConversationLinks
						>[0]["conversations"]
					}
				/>
			) : null}
			{onClearAll && (
				<Button
					variant="subtle"
					size="compact-xs"
					className="not-italic"
					onClick={onClearAll}
					disabled={disabled}
					loading={isClearing}
					{...testId("chat-composer-clear-focus")}
				>
					<Trans>Clear all</Trans>
				</Button>
			)}
		</Group>
	);
};

export const ConversationPickerButton = ({
	ariaLabel,
	disabled,
	label,
	onClick,
	testId: id,
}: {
	ariaLabel: string;
	disabled?: boolean;
	label: React.ReactNode;
	onClick: () => void;
	testId?: string;
}) => (
	<Button
		variant="subtle"
		size="compact-xs"
		disabled={disabled}
		onClick={onClick}
		aria-label={ariaLabel}
		{...(id ? testId(id) : {})}
	>
		<ChatCircleTextIcon size={14} />
		<span className="ms-1.5 hidden md:inline">{label}</span>
	</Button>
);
