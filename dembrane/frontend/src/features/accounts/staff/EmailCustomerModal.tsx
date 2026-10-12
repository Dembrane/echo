import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import type { ResponseOf } from "../api/client";
import { useAccountsMutation } from "../api/hooks";

/** What the manager emails the customer about: a withdrawn document or a waiting task. */
export type EmailSubject =
	| { kind: "document_withdrawn"; document_id: string; label: string }
	| { kind: "task_reminder"; task_id: string; label: string };

/**
 * Staff: email the people who run the account about one thing. sam only tells the manager
 * in Slack; the manager sends from here. The preview is the email echo will send, in the
 * first recipient's language; the manager's own line goes in under the opening.
 */
export function EmailCustomerModal({
	subject,
	onClose,
	orgId,
}: {
	subject: EmailSubject | null;
	onClose: () => void;
	orgId: string;
}) {
	const [note, setNote] = useState("");
	const [preview, setPreview] = useState<ResponseOf<"sendMessage"> | null>(
		null,
	);
	const render = useAccountsMutation("sendMessage", { orgId });
	const send = useAccountsMutation("sendMessage", { orgId });
	const { label: _, ...target } = subject ?? { label: "" };
	const body = (dry_run: boolean) =>
		({ ...target, dry_run, note: note.trim() || null }) as never;

	// Draw the preview on open, and again when the manager stops typing their line.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-render on subject and note only
	useEffect(() => {
		if (!subject) {
			setPreview(null);
			return;
		}
		const id = setTimeout(
			() =>
				render.mutate(
					{ body: body(true) },
					{ onError: (e) => void notifyError(e), onSuccess: setPreview },
				),
			note ? 400 : 0,
		);
		return () => clearTimeout(id);
	}, [subject, note]);

	const close = () => {
		setNote("");
		onClose();
	};
	const first = preview?.messages[0];
	return (
		<Modal
			opened={subject !== null}
			onClose={close}
			title={t`Email the customer`}
			centered
			size="lg"
		>
			<Stack gap="sm">
				<Text size="sm">{subject?.label}</Text>
				<Textarea
					label={t`Your own line (optional)`}
					description={t`Shown as written, under the opening. Write it in the customer's language.`}
					autosize
					minRows={2}
					maxLength={1000}
					value={note}
					onChange={(e) => setNote(e.currentTarget.value)}
				/>
				{!preview ? (
					<Loader size="sm" />
				) : !first ? (
					<Text size="sm" c="dimmed">
						<Trans>Nobody on this account has an email address yet.</Trans>
					</Text>
				) : (
					<>
						<Text size="xs" c="dimmed">
							{t`To: ${preview.messages.map((m) => m.to).join(", ")}`}
						</Text>
						<Paper withBorder p="sm" data-testid="email-preview">
							<Text size="sm" fw={500}>
								{first.subject}
							</Text>
							<Text size="sm" mt="xs" style={{ whiteSpace: "pre-wrap" }}>
								{first.text}
							</Text>
						</Paper>
					</>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={close}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						disabled={!first}
						loading={send.isPending}
						data-testid="email-send"
						onClick={() =>
							send.mutate(
								{ body: body(false) },
								{
									onError: (e) => void notifyError(e),
									onSuccess: (r) => {
										toast.success(
											r.queued === 1
												? t`Email sent`
												: t`${r.queued} emails sent`,
										);
										close();
									},
								},
							)
						}
					>
						<Trans>Send</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
