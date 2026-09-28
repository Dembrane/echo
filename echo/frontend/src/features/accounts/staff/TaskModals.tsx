import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { useAccountsMutation } from "../api/hooks";
import type { DocumentSummaryT, TaskT } from "../contract/contract.gen";

/** Staff: an ad hoc task ("send us your PO number"), optionally held until a document is signed. */
export function NewTaskModal({
	opened,
	onClose,
	orgId,
	documents,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	documents: DocumentSummaryT[];
}) {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [kind, setKind] = useState<"generic" | "upload">("generic");
	const [lockUntil, setLockUntil] = useState<string | null>(null);
	const create = useAccountsMutation("createTask", { orgId });
	const unsigned = documents.filter(
		(d) =>
			d.requires_signature && (d.status === "sent" || d.status === "viewed"),
	);
	return (
		<Modal opened={opened} onClose={onClose} title={t`New task`} centered>
			<Stack gap="sm">
				<TextInput
					label={t`Title`}
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					placeholder={t`Send us your PO number`}
					data-testid="task-title"
				/>
				<Textarea
					label={t`What we ask`}
					description={t`Optional`}
					autosize
					minRows={2}
					value={body}
					onChange={(e) => setBody(e.currentTarget.value)}
				/>
				<Select
					label={t`The customer answers with`}
					value={kind}
					onChange={(v) => setKind((v as typeof kind) ?? "generic")}
					data={[
						{ label: t`A text answer`, value: "generic" },
						{ label: t`A file`, value: "upload" },
					]}
					allowDeselect={false}
				/>
				{unsigned.length > 0 && (
					<Select
						label={t`Opens after signing`}
						description={t`Optional. The task stays greyed out until this document is signed.`}
						clearable
						value={lockUntil}
						onChange={setLockUntil}
						data={unsigned.map((d) => ({ label: d.title, value: d.id }))}
					/>
				)}
				<Text size="xs" c="dimmed">
					<Trans>
						The customer gets a reminder every seven days until it is done.
					</Trans>
				</Text>
				<Group justify="flex-end">
					<Button
						disabled={!title.trim()}
						loading={create.isPending}
						onClick={() =>
							create.mutate(
								{
									body: {
										body,
										kind,
										locked_until_document_id: lockUntil,
										title,
									},
								},
								{
									onSuccess: () => {
										toast.success(t`Task created`);
										setTitle("");
										setBody("");
										setLockUntil(null);
										onClose();
									},
								},
							)
						}
						data-testid="task-create"
					>
						<Trans>Create task</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/** Staff: return a submitted task with what to change. The note is required. */
export function SendBackModal({
	task,
	onClose,
	orgId,
}: {
	task: TaskT | null;
	onClose: () => void;
	orgId: string;
}) {
	const [note, setNote] = useState("");
	const review = useAccountsMutation("reviewTask", { orgId });
	return (
		<Modal
			opened={task !== null}
			onClose={onClose}
			title={t`Send back`}
			centered
		>
			<Stack gap="sm">
				<Text size="sm">{task?.title}</Text>
				<Textarea
					label={t`What to change`}
					autosize
					minRows={3}
					value={note}
					onChange={(e) => setNote(e.currentTarget.value)}
				/>
				<Group justify="flex-end">
					<Button
						disabled={!note.trim()}
						loading={review.isPending}
						onClick={() =>
							task &&
							review.mutate(
								{
									body: { decision: "send_back", note },
									params: { taskId: task.id },
								},
								{
									onSuccess: () => {
										setNote("");
										onClose();
									},
								},
							)
						}
					>
						<Trans>Send back</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
