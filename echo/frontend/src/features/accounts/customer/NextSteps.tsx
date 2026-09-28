import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Button,
	FileButton,
	Flex,
	Group,
	Modal,
	Paper,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { call, submitTaskWithFile } from "../api/client";
import { accountKeys } from "../api/hooks";
import type { TaskT } from "../contract/contract.gen";
import { Section } from "../ui";

const ACTIVE: TaskT["status"][] = ["open", "changes_requested"];

/**
 * The open tasks as actions, the locked billing step greyed out with why, and what waits
 * on us. Done and withdrawn steps fold into one line so the list stays about what is next.
 */
export function NextSteps({
	orgId,
	tasks,
	onBilling,
}: {
	orgId: string;
	tasks: TaskT[];
	onBilling: () => void;
}) {
	const [showDone, setShowDone] = useState(false);
	const [responding, setResponding] = useState<TaskT | null>(null);
	const current = tasks.filter(
		(task) => task.status !== "done" && task.status !== "withdrawn",
	);
	const done = tasks.filter((task) => task.status === "done");

	return (
		<Section title={<Trans>Next steps</Trans>} testId="next-steps">
			<Stack gap="xs">
				{current.length === 0 && (
					<Text size="sm" c="dimmed">
						<Trans>Nothing to do right now.</Trans>
					</Text>
				)}
				{current.map((task) => (
					<TaskRow
						key={task.id}
						task={task}
						orgId={orgId}
						onBilling={onBilling}
						onRespond={() => setResponding(task)}
					/>
				))}
				{showDone &&
					done.map((task) => (
						<TaskRow
							key={task.id}
							task={task}
							orgId={orgId}
							onBilling={onBilling}
							onRespond={() => {}}
						/>
					))}
				{done.length > 0 && (
					<Anchor
						component="button"
						size="sm"
						c="dimmed"
						ta="left"
						onClick={() => setShowDone((v) => !v)}
					>
						{showDone ? (
							<Trans>Hide done steps</Trans>
						) : (
							<Plural
								value={done.length}
								one="# step done"
								other="# steps done"
							/>
						)}
					</Anchor>
				)}
			</Stack>
			<TaskResponseModal
				task={responding}
				orgId={orgId}
				onClose={() => setResponding(null)}
			/>
		</Section>
	);
}

function TaskRow({
	task,
	orgId,
	onBilling,
	onRespond,
}: {
	task: TaskT;
	orgId: string;
	onBilling: () => void;
	onRespond: () => void;
}) {
	const locked = task.locked || task.status === "locked";
	const active = ACTIVE.includes(task.status);
	const action = (() => {
		if (!active) return null;
		if (task.kind === "sign" && task.document_id) {
			return (
				<Button
					component={I18nLink}
					to={`/o/${orgId}/account/documents/${task.document_id}/sign`}
					data-testid="action-sign"
				>
					<Trans>Review and sign</Trans>
				</Button>
			);
		}
		if (task.kind === "billing_details") {
			return (
				<Button onClick={onBilling} data-testid="action-billing">
					<Trans>Fill in</Trans>
				</Button>
			);
		}
		return (
			<Button variant="light" onClick={onRespond}>
				{task.kind === "upload" ? <Trans>Upload</Trans> : <Trans>Reply</Trans>}
			</Button>
		);
	})();

	return (
		<Paper
			withBorder
			p="sm"
			radius="md"
			data-testid={`task-${task.kind}`}
			data-status={task.status}
			style={
				locked || !active
					? { background: "var(--mantine-color-gray-0)" }
					: undefined
			}
		>
			<Flex
				direction={{ base: "column", xs: "row" }}
				gap="sm"
				justify="space-between"
				align={{ base: "stretch", xs: "center" }}
			>
				<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
					<Group gap={6} wrap="nowrap">
						{locked && (
							<LockSimpleIcon size={14} color="var(--mantine-color-gray-6)" />
						)}
						<Text
							fw={500}
							size="sm"
							c={locked || !active ? "dimmed" : undefined}
						>
							{task.title}
						</Text>
					</Group>
					{locked ? (
						<Text size="sm" c="dimmed">
							<Trans>Opens after signing.</Trans>
						</Text>
					) : task.status === "changes_requested" && task.review_note ? (
						<Text size="sm" c="orange.8">
							<Trans>We asked for a change: {task.review_note}</Trans>
						</Text>
					) : active && task.body ? (
						<Text size="sm" c="dimmed" lineClamp={2}>
							{task.body}
						</Text>
					) : null}
				</Stack>
				{action}
				{task.status === "submitted" && (
					<Badge variant="light" color="gray" style={{ flexShrink: 0 }}>
						<Trans>Waiting on dembrane</Trans>
					</Badge>
				)}
				{task.status === "done" && (
					<Badge variant="light" color="green" style={{ flexShrink: 0 }}>
						<Trans>Done</Trans>
					</Badge>
				)}
			</Flex>
		</Paper>
	);
}

function TaskResponseModal({
	task,
	orgId,
	onClose,
}: {
	task: TaskT | null;
	orgId: string;
	onClose: () => void;
}) {
	const [text, setText] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [pending, setPending] = useState(false);
	const queryClient = useQueryClient();
	const needsFile = task?.kind === "upload";

	const submit = async () => {
		if (!task) return;
		setPending(true);
		try {
			if (file) {
				await submitTaskWithFile(
					{ orgId, taskId: task.id },
					text.trim() || null,
					file,
				);
			} else {
				await call("submitTask", {
					body: { response_text: text },
					params: { orgId, taskId: task.id },
				});
			}
			await queryClient.invalidateQueries({ queryKey: accountKeys.all });
			toast.success(t`Sent to dembrane`);
			setText("");
			setFile(null);
			onClose();
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : t`That did not go through. Try again.`,
			);
		} finally {
			setPending(false);
		}
	};

	return (
		<Modal
			opened={task !== null}
			onClose={onClose}
			title={task?.title}
			centered
		>
			<Stack gap="sm">
				{task?.body && (
					<Text size="sm" c="dimmed">
						{task.body}
					</Text>
				)}
				{needsFile && (
					<Group gap="sm">
						<FileButton onChange={setFile}>
							{(props) => (
								<Button variant="default" {...props}>
									<Trans>Choose a file</Trans>
								</Button>
							)}
						</FileButton>
						<Text size="sm" c="dimmed" truncate style={{ flex: 1 }}>
							{file?.name ?? <Trans>No file chosen</Trans>}
						</Text>
					</Group>
				)}
				<Textarea
					label={needsFile ? t`Note` : t`Your answer`}
					description={needsFile ? t`Optional` : undefined}
					autosize
					minRows={3}
					value={text}
					onChange={(e) => setText(e.currentTarget.value)}
				/>
				<Group justify="flex-end">
					<Button
						loading={pending}
						disabled={needsFile ? !file : !text.trim()}
						onClick={submit}
					>
						<Trans>Send</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
