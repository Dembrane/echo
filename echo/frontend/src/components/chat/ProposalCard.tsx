import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import {
	useProjectById,
	useUpdateProjectByIdMutation,
} from "@/components/project/hooks";
import type { AgenticProposal } from "./agenticProposal";

type ProposalStatus = "pending" | "applied" | "declined";

const isTextareaField = (field: string) => field === "context";

export const ProposalCard = ({ proposal }: { proposal: AgenticProposal }) => {
	const [status, setStatus] = useState<ProposalStatus>("pending");
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			proposal.edits.map((edit) => [edit.field, edit.proposedValue]),
		),
	);

	const supported =
		proposal.proposalType === "update_project" && !!proposal.projectId;

	// Read live state so the diff shows real current -> proposed, never a
	// baseline the agent guessed at.
	const { data: project } = useProjectById({
		projectId: proposal.projectId ?? "",
	});
	const updateMutation = useUpdateProjectByIdMutation();

	const currentValueFor = (field: string): string => {
		const raw = project
			? (project as unknown as Record<string, unknown>)[field]
			: undefined;
		return typeof raw === "string" ? raw : "";
	};

	const handleApply = async () => {
		if (!proposal.projectId) return;
		// The accept path runs as the host through the normal authenticated
		// endpoint. The agent never holds write authority; this is the inversion.
		const payload: Partial<Project> = {};
		for (const edit of proposal.edits) {
			(payload as Record<string, string>)[edit.field] =
				values[edit.field] ?? "";
		}
		try {
			await updateMutation.mutateAsync({ id: proposal.projectId, payload });
			setStatus("applied");
		} catch {
			// the mutation hook surfaces its own error toast
		}
	};

	if (!supported) {
		return (
			<Box className="w-full rounded border border-gray-300 px-3 py-2 md:max-w-[80%]">
				<Text size="sm" fw={700}>
					{proposal.title}
				</Text>
				<Text size="xs" c="dimmed" className="mt-1">
					<Trans>This kind of proposal is not supported yet.</Trans>
				</Text>
			</Box>
		);
	}

	return (
		<Box
			data-testid="agentic-proposal-card"
			className="w-full rounded border border-gray-300 px-3 py-3 md:max-w-[80%]"
			style={{
				borderLeftColor: "var(--mantine-color-primary-6)",
				borderLeftWidth: 3,
			}}
		>
			<Group justify="space-between" align="center" wrap="nowrap">
				<Text size="sm" fw={700}>
					{proposal.title}
				</Text>
				{status === "pending" && (
					<Badge variant="light" color="primary" size="sm">
						<Trans>Proposal</Trans>
					</Badge>
				)}
				{status === "applied" && (
					<Badge color="primary" size="sm">
						<Trans>Applied</Trans>
					</Badge>
				)}
				{status === "declined" && (
					<Badge color="gray" size="sm">
						<Trans>Declined</Trans>
					</Badge>
				)}
			</Group>

			{proposal.reason && (
				<Text size="xs" c="dimmed" className="mt-1">
					{proposal.reason}
				</Text>
			)}

			<Stack gap="sm" className="mt-3">
				{proposal.edits.map((edit) => {
					const current = currentValueFor(edit.field);
					const proposed = values[edit.field] ?? "";
					const changed = current !== proposed;
					return (
						<Box key={edit.field}>
							<Text size="xs" fw={700} c="dark">
								{edit.label}
							</Text>
							<Text
								size="xs"
								c="dimmed"
								className="mt-1 whitespace-pre-wrap break-words line-through"
							>
								{current || <Trans>(empty)</Trans>}
							</Text>
							{isTextareaField(edit.field) ? (
								<Textarea
									className="mt-1"
									autosize
									minRows={2}
									maxRows={8}
									value={proposed}
									disabled={status !== "pending"}
									onChange={(event) =>
										setValues((previous) => ({
											...previous,
											[edit.field]: event.currentTarget.value,
										}))
									}
								/>
							) : (
								<TextInput
									className="mt-1"
									value={proposed}
									disabled={status !== "pending"}
									onChange={(event) =>
										setValues((previous) => ({
											...previous,
											[edit.field]: event.currentTarget.value,
										}))
									}
								/>
							)}
							{!changed && status === "pending" && (
								<Text size="xs" c="dimmed" className="mt-1">
									<Trans>No change from current value.</Trans>
								</Text>
							)}
						</Box>
					);
				})}
			</Stack>

			{status === "pending" && (
				<Group justify="flex-end" gap="xs" className="mt-3">
					<Button
						variant="subtle"
						size="xs"
						leftSection={<IconX size={14} />}
						onClick={() => setStatus("declined")}
						data-testid="agentic-proposal-decline"
					>
						<Trans>Decline</Trans>
					</Button>
					<Button
						size="xs"
						leftSection={
							updateMutation.isPending ? (
								<Loader size={12} />
							) : (
								<IconCheck size={14} />
							)
						}
						onClick={() => void handleApply()}
						disabled={updateMutation.isPending}
						data-testid="agentic-proposal-apply"
					>
						<Trans>Apply</Trans>
					</Button>
				</Group>
			)}
		</Box>
	);
};
