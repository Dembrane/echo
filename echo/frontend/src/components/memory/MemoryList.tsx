import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { type AgentMemory, useDeleteMemoryMutation } from "./hooks";

type MemoryListProps = {
	memories: AgentMemory[] | undefined;
	isLoading: boolean;
	emptyText: string;
};

/**
 * Read-only list of what the assistant remembers, with per-row Remove.
 * Hosts cannot author or edit memories here; the assistant is the only
 * writer. Shared by the user, project, and workspace surfaces.
 */
export const MemoryList = ({
	memories,
	isLoading,
	emptyText,
}: MemoryListProps) => {
	const deleteMutation = useDeleteMemoryMutation();
	const [toRemove, setToRemove] = useState<AgentMemory | null>(null);

	if (isLoading) {
		return (
			<Group justify="center" py="md">
				<Loader size="sm" />
			</Group>
		);
	}

	if (!memories || memories.length === 0) {
		return <Text size="sm">{emptyText}</Text>;
	}

	const handleConfirm = () => {
		if (!toRemove) return;
		deleteMutation.mutate(toRemove.id, {
			onError: (error: Error) =>
				toast.error(error.message || t`Couldn't remove this memory`),
			onSettled: () => setToRemove(null),
			onSuccess: () => toast.success(t`Memory removed`),
		});
	};

	return (
		<Stack gap={0}>
			{memories.map((memory) => (
				<Group
					key={memory.id}
					wrap="nowrap"
					align="flex-start"
					justify="space-between"
					py="sm"
					className="border-b border-gray-200 last:border-b-0"
				>
					<Stack gap={2} className="min-w-0">
						<Text size="sm" className="whitespace-pre-wrap break-words">
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
