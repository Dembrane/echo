import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	FileButton,
	Group,
	Modal,
	Paper,
	Stack,
	Text,
	Textarea,
	ThemeIcon,
} from "@mantine/core";
import { CheckIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { call, submitTaskWithFile } from "../api/client";
import { accountKeys } from "../api/hooks";
import type { TaskT } from "../contract/contract.gen";
import { taskText } from "../format";
import { Section } from "../ui";

const ACTIVE: TaskT["status"][] = ["open", "changes_requested"];

/** Stepper order: what is done, what is with us, what is to do, what is still locked. */
const RANK: Record<TaskT["status"], number> = {
	changes_requested: 2,
	done: 0,
	locked: 3,
	open: 2,
	submitted: 1,
	withdrawn: 4,
};

/**
 * Next steps as a numbered stepper: done steps checked, the current step highlighted
 * with its action, steps with dembrane marked and without an action, locked steps greyed
 * with the document they wait for.
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
	const [responding, setResponding] = useState<TaskT | null>(null);
	const steps = tasks
		.filter((task) => task.status !== "withdrawn")
		.map((task, i) => ({ i, task }))
		.sort((a, b) => RANK[a.task.status] - RANK[b.task.status] || a.i - b.i)
		.map(({ task }) => task);
	const currentId =
		steps.find((task) => ACTIVE.includes(task.status))?.id ?? null;

	return (
		<Section title={<Trans>Next steps</Trans>} testId="next-steps">
			{steps.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>Nothing to do right now.</Trans>
				</Text>
			) : (
				<Stack gap={0} component="ol" p={0} m={0} style={{ listStyle: "none" }}>
					{steps.map((task, index) => (
						<Step
							key={task.id}
							n={index + 1}
							last={index === steps.length - 1}
							task={task}
							current={task.id === currentId}
							orgId={orgId}
							onBilling={onBilling}
							onRespond={() => setResponding(task)}
						/>
					))}
				</Stack>
			)}
			<TaskResponseModal
				task={responding}
				orgId={orgId}
				onClose={() => setResponding(null)}
			/>
		</Section>
	);
}

function Step({
	n,
	last,
	task,
	current,
	orgId,
	onBilling,
	onRespond,
}: {
	n: number;
	last: boolean;
	task: TaskT;
	current: boolean;
	orgId: string;
	onBilling: () => void;
	onRespond: () => void;
}) {
	const { title, body } = taskText(task);
	const locked = task.locked || task.status === "locked";
	const done = task.status === "done";
	const withUs = task.status === "submitted";
	const active = ACTIVE.includes(task.status);
	const variant = current ? "filled" : "light";

	const action = (() => {
		if (!active) return null;
		if (task.kind === "sign" && task.document_id) {
			return (
				<Button
					variant={variant}
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
				<Button
					variant={variant}
					onClick={onBilling}
					data-testid="action-billing"
				>
					<Trans>Fill in</Trans>
				</Button>
			);
		}
		return (
			<Button variant={variant} onClick={onRespond}>
				{task.kind === "upload" ? <Trans>Upload</Trans> : <Trans>Reply</Trans>}
			</Button>
		);
	})();

	const marker = done ? (
		<ThemeIcon size={26} radius="xl" color="green" variant="light">
			<CheckIcon size={14} />
		</ThemeIcon>
	) : locked ? (
		<ThemeIcon size={26} radius="xl" color="gray" variant="light">
			<LockSimpleIcon size={13} />
		</ThemeIcon>
	) : (
		<ThemeIcon
			size={26}
			radius="xl"
			color={current ? "blue" : "gray"}
			variant={current ? "filled" : "light"}
		>
			<Text size="xs" fw={600}>
				{n}
			</Text>
		</ThemeIcon>
	);

	return (
		<Box
			component="li"
			data-testid={`task-${task.kind}`}
			data-status={task.status}
			data-current={current ? "true" : undefined}
		>
			<Group gap="sm" align="stretch" wrap="nowrap">
				{/* The marker column with the line down to the next step. */}
				<Stack gap={0} align="center" style={{ flexShrink: 0 }}>
					{marker}
					{!last && (
						<Box
							style={{
								background: "var(--mantine-color-gray-3)",
								flex: 1,
								minHeight: 12,
								width: 1.5,
							}}
						/>
					)}
				</Stack>
				<Paper
					withBorder={current}
					p={current ? "sm" : 0}
					pb={last ? 0 : "md"}
					radius="md"
					style={{
						background: current ? undefined : "transparent",
						border: current ? undefined : 0,
						flex: 1,
						marginBottom: current && !last ? 12 : 0,
						minWidth: 0,
					}}
				>
					<Stack gap={6}>
						<Group justify="space-between" wrap="wrap" gap="xs" align="center">
							<Stack gap={2} style={{ flex: "1 1 220px", minWidth: 0 }}>
								<Text
									fw={current ? 500 : 400}
									size="sm"
									c={locked || done ? "dimmed" : undefined}
									pt={current ? 0 : 3}
								>
									{title}
								</Text>
								{locked ? (
									<Text size="sm" c="dimmed">
										{task.locked_until_title ? (
											<Trans>
												Opens after you sign {task.locked_until_title}.
											</Trans>
										) : (
											<Trans>Opens after signing.</Trans>
										)}
									</Text>
								) : task.status === "changes_requested" && task.review_note ? (
									<Text size="sm" c="orange.8">
										<Trans>We asked for a change: {task.review_note}</Trans>
									</Text>
								) : active && body ? (
									<Text size="sm" c="dimmed" lineClamp={current ? 3 : 1}>
										{body}
									</Text>
								) : null}
							</Stack>
							{withUs && (
								<Badge variant="light" color="gray" style={{ flexShrink: 0 }}>
									<Trans>With dembrane</Trans>
								</Badge>
							)}
							{action}
						</Group>
					</Stack>
				</Paper>
			</Group>
		</Box>
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
	const copy = task ? taskText(task) : null;
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
			void notifyError(e);
		} finally {
			setPending(false);
		}
	};

	return (
		<Modal
			opened={task !== null}
			onClose={onClose}
			title={copy?.title}
			centered
		>
			<Stack gap="sm">
				{copy?.body && (
					<Text size="sm" c="dimmed">
						{copy.body}
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
