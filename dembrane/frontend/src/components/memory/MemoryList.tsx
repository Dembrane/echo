import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Skeleton, Stack, Text } from "@mantine/core";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { notifyError } from "@/components/error/notifyError";
import { ruleBetween } from "@/components/workspace/ruleBetween";
import { type AgentMemory, useDeleteMemoryMutation } from "./hooks";

// The list only knows that the read failed, not why. Module-level so
// ErrorNotice sees the same object on every render.
const MEMORIES_UNAVAILABLE = new Error("Memories unavailable");

type MemoryListProps = {
	memories: AgentMemory[] | undefined;
	isLoading: boolean;
	isError: boolean;
	emptyText?: string;
};

/**
 * Read-only list of what the assistant remembers, with per-row Remove.
 * Hosts cannot author or edit memories here; the assistant is the only
 * writer. Shared by the user, project, and workspace surfaces.
 */
export const MemoryList = ({
	memories,
	isLoading,
	isError,
	emptyText,
}: MemoryListProps) => {
	const deleteMutation = useDeleteMemoryMutation();
	const [toRemove, setToRemove] = useState<AgentMemory | null>(null);

	if (isLoading) {
		return (
			<Stack gap="sm">
				<Skeleton height={16} width="80%" />
				<Skeleton height={16} width="64%" />
				<Skeleton height={16} width="72%" />
			</Stack>
		);
	}

	// A failed read must never look like "nothing stored": hosts read the
	// empty state as reassurance about what the assistant keeps.
	if (isError) {
		return (
			<ErrorNotice
				error={MEMORIES_UNAVAILABLE}
				title={t`Couldn't load memories. Refresh to try again.`}
			/>
		);
	}

	if (!memories || memories.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{emptyText ??
					t`Nothing saved yet. The assistant adds notes here as people chat.`}
			</Text>
		);
	}

	const handleConfirm = () => {
		if (!toRemove) return;
		deleteMutation.mutate(toRemove.id, {
			onError: (error: Error) => void notifyError(error),
			onSettled: () => setToRemove(null),
			onSuccess: () => toast.success(t`Memory removed`),
		});
	};

	return (
		<Stack gap={0}>
			{memories.map((memory, i) => (
				<Group
					key={memory.id}
					wrap="nowrap"
					align="flex-start"
					justify="space-between"
					py="sm"
					style={ruleBetween(i, memories.length)}
				>
					<Stack gap={0} className="min-w-0">
						<Text className="whitespace-pre-wrap break-words">
							{memory.content}
						</Text>
						{memory.updated_at && (
							<Text size="xs">
								{formatDistanceToNow(new Date(memory.updated_at), {
									addSuffix: true,
								})}
							</Text>
						)}
					</Stack>
					<Button
						variant="subtle"
						size="compact-sm"
						color="red"
						onClick={() => setToRemove(memory)}
						className="shrink-0"
					>
						<Trans>Remove</Trans>
					</Button>
				</Group>
			))}

			<ConfirmModal
				opened={toRemove !== null}
				onClose={() => setToRemove(null)}
				onConfirm={handleConfirm}
				title={t`Remove this memory?`}
				message={
					<Stack gap="xs">
						<Text size="sm" className="whitespace-pre-wrap break-words">
							{toRemove?.content}
						</Text>
						<Text size="sm">
							<Trans>The assistant forgets it in every future chat.</Trans>
						</Text>
					</Stack>
				}
				confirmLabel={<Trans>Remove</Trans>}
				confirmColor="red"
				loading={deleteMutation.isPending}
				data-testid="memory-remove-modal"
			/>
		</Stack>
	);
};
