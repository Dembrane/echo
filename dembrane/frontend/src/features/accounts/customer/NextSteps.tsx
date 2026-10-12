import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	FileButton,
	Group,
	Modal,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import {
	CheckIcon,
	HourglassSimpleIcon,
	LockSimpleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { getDocumentationUrl } from "@/config";
import { call, submitTaskWithFile } from "../api/client";
import { accountKeys } from "../api/hooks";
import type { TaskT } from "../contract/contract.gen";
import { formatDate, taskText } from "../format";
import { PageSection, Row, Rows } from "./PageSection";
import { type AccountPlan, waitsOnWhoSigns } from "./plan";
import { SendToSomeoneElse } from "./SendToSomeoneElse";
import { WhoSigns } from "./WhoSigns";

/** Steps done by taking them, never by a reply: their button leads to the step. */
const ONBOARDING: NonNullable<TaskT["code"]>[] = [
	"explore_demo",
	"watch_tutorial",
	"create_project",
	"book_call",
];

/**
 * What the customer has to do, then what is coming: tasks are a set, not a sequence, so
 * there are no step numbers. Each open task is a row with its words and its action, and
 * that action is the row's one blue pill. Below it,
 * quieter, what dembrane is working on and what opens after a signature, and the finished
 * tasks folded away.
 */
export function NextSteps({
	orgId,
	plan,
	onBilling,
	onBookCall,
}: {
	orgId: string;
	plan: Pick<AccountPlan, "toDo" | "waiting" | "withUs" | "later" | "done">;
	onBilling: () => void;
	onBookCall: () => void;
}) {
	const [responding, setResponding] = useState<TaskT | null>(null);
	const [sendingTo, setSendingTo] = useState<string | null>(null);
	const [asking, setAsking] = useState<TaskT | null>(null);
	const [showDone, setShowDone] = useState(false);
	const { toDo, waiting, withUs, later, done } = plan;
	const coming = [...withUs, ...later];
	const ahead = waiting.length + coming.length;
	const nothing = toDo.length + ahead + done.length === 0;
	if (nothing) return null;

	return (
		<>
			{toDo.length > 0 && (
				<PageSection title={<Trans>To do</Trans>} testId="next-steps">
					<Rows>
						{toDo.map((task, i) => (
							<OpenTask
								key={task.id}
								task={task}
								first={i === 0}
								orgId={orgId}
								onBilling={onBilling}
								onBookCall={onBookCall}
								onRespond={() => setResponding(task)}
								onSendTo={() => setSendingTo(task.document_id)}
								onWhoSigns={() => setAsking(task)}
							/>
						))}
					</Rows>
				</PageSection>
			)}

			{(ahead > 0 || done.length > 0) && (
				<PageSection
					title={ahead > 0 ? <Trans>Coming up</Trans> : <Trans>Done</Trans>}
					testId="coming-up"
					action={
						done.length > 0 ? (
							<Anchor
								component="button"
								size="sm"
								onClick={() => setShowDone((v) => !v)}
								aria-expanded={showDone}
								data-testid="show-done"
							>
								{showDone ? (
									<Trans>Hide finished</Trans>
								) : (
									<Trans>Show finished ({done.length})</Trans>
								)}
							</Anchor>
						) : undefined
					}
				>
					{(ahead > 0 || showDone) && (
						<Rows>
							{waiting.map(({ task, signer }) => (
								<WaitingTask
									key={task.id}
									task={task}
									signer={signer}
									orgId={orgId}
									onSendTo={() => setSendingTo(task.document_id)}
								/>
							))}
							{coming.map((task) => (
								<QuietTask
									key={task.id}
									task={task}
									afterWhoSigns={waitsOnWhoSigns(task, toDo)}
								/>
							))}
							{showDone &&
								done.map((task) => <QuietTask key={task.id} task={task} />)}
						</Rows>
					)}
				</PageSection>
			)}

			<TaskResponseModal
				task={responding}
				orgId={orgId}
				onClose={() => setResponding(null)}
			/>
			<WhoSigns orgId={orgId} task={asking} onClose={() => setAsking(null)} />
			<SendToSomeoneElse
				orgId={orgId}
				docId={sendingTo}
				opened={sendingTo !== null}
				onClose={() => setSendingTo(null)}
			/>
		</>
	);
}

function OpenTask({
	task,
	first,
	orgId,
	onBilling,
	onBookCall,
	onRespond,
	onSendTo,
	onWhoSigns,
}: {
	task: TaskT;
	first: boolean;
	orgId: string;
	onBilling: () => void;
	onBookCall: () => void;
	onRespond: () => void;
	onSendTo: () => void;
	onWhoSigns: () => void;
}) {
	const { title, body } = taskText(task);
	// Every task's own action is its blue pill: one clear next step per row.
	const variant = "filled";
	const sentBack = task.status === "changes_requested";

	const action = (() => {
		if (task.kind === "sign" && task.document_id) {
			// Signing it, or handing it to whoever signs for the organisation: both are
			// right here, so the task needs no words of its own.
			return (
				<Group gap="xs" wrap="wrap">
					<Button
						variant={variant}
						component={I18nLink}
						to={`/o/${orgId}/account/documents/${task.document_id}/sign`}
						data-testid="action-sign"
					>
						<Trans>Review and sign</Trans>
					</Button>
					<Button
						variant="outline"
						onClick={onSendTo}
						data-testid="action-send-to"
					>
						<Trans>Send to someone else</Trans>
					</Button>
				</Group>
			);
		}
		if (task.code === "who_signs") {
			return (
				<Button
					variant={variant}
					onClick={onWhoSigns}
					data-testid="action-who-signs"
				>
					<Trans>Start</Trans>
				</Button>
			);
		}
		if (task.code && ONBOARDING.includes(task.code)) {
			return (
				<OnboardingAction
					task={task}
					orgId={orgId}
					variant={variant}
					onBookCall={onBookCall}
				/>
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

	return (
		<Row
			testId={`task-${task.kind}`}
			data-status={task.status}
			data-current={first ? "true" : undefined}
		>
			<Group justify="space-between" align="center" gap="sm" wrap="wrap">
				<Stack gap={4} style={{ flex: "1 1 260px", minWidth: 0 }}>
					<Text>{title}</Text>
					{sentBack && task.review_note ? (
						<Text size="sm" c="var(--app-warning)">
							<Trans>We asked for a change: {task.review_note}</Trans>
						</Text>
					) : body ? (
						<Text size="sm" c="dimmed" lineClamp={first ? 4 : 2}>
							{body}
						</Text>
					) : null}
					{task.due_on && <Due iso={task.due_on} />}
				</Stack>
				{action}
			</Group>
		</Row>
	);
}

function Due({ iso }: { iso: string }) {
	const { i18n } = useLingui();
	const date = formatDate(iso, i18n.locale);
	return (
		<Text size="sm" c="dimmed">
			<Trans>Before {date}</Trans>
		</Text>
	);
}

/**
 * A signature handed to someone else: it waits on them, and their signature completes it.
 * The offer can still be read here, and handed to someone else again.
 */
function WaitingTask({
	task,
	signer,
	orgId,
	onSendTo,
}: {
	task: TaskT;
	signer: { name: string | null; email: string; role: string | null };
	orgId: string;
	onSendTo: () => void;
}) {
	const { title } = taskText(task);
	const who = signer.name || signer.email;
	const jobTitle = signer.role;
	return (
		<Row testId="task-waiting" data-status="waiting">
			<Group justify="space-between" align="center" gap="sm" wrap="wrap">
				<Group
					gap="sm"
					wrap="nowrap"
					align="flex-start"
					style={{ flex: "1 1 260px", minWidth: 0 }}
				>
					<Box pt="xs" style={{ flexShrink: 0, lineHeight: 0 }}>
						<HourglassSimpleIcon
							size={16}
							color="var(--app-muted)"
							aria-hidden
						/>
					</Box>
					<Stack gap={4} style={{ minWidth: 0 }}>
						<Text>{title}</Text>
						<Text size="sm" c="dimmed" data-testid="waiting-on">
							{jobTitle ? (
								<Trans>
									Waiting on {who}, {jobTitle}. We emailed them a link to sign.
								</Trans>
							) : (
								<Trans>Waiting on {who}. We emailed them a link to sign.</Trans>
							)}
						</Text>
					</Stack>
				</Group>
				<Group gap="xs" wrap="wrap" justify="flex-end">
					<Anchor component="button" size="sm" onClick={onSendTo}>
						<Trans>Send to someone else</Trans>
					</Anchor>
					<Button
						component={I18nLink}
						to={`/o/${orgId}/account/documents/${task.document_id}/sign`}
						data-testid="action-view-offer"
					>
						<Trans>View</Trans>
					</Button>
				</Group>
			</Group>
		</Row>
	);
}

/** A task that is not the customer's move: with dembrane, waiting on a signature, or done. */
function QuietTask({
	task,
	afterWhoSigns = false,
}: {
	task: TaskT;
	/** A signature that opens once the customer has said who signs. */
	afterWhoSigns?: boolean;
}) {
	const { i18n } = useLingui();
	const { title } = taskText(task);
	const locked = afterWhoSigns || task.locked || task.status === "locked";
	const done = task.status === "done";
	const icon = done ? (
		<CheckIcon size={16} color="var(--app-success)" aria-hidden />
	) : locked ? (
		<LockSimpleIcon size={16} color="var(--app-muted)" aria-hidden />
	) : (
		<HourglassSimpleIcon size={16} color="var(--app-muted)" aria-hidden />
	);
	const when = formatDate(task.submitted_at, i18n.locale);
	const note = afterWhoSigns ? (
		<Trans>Opens after you tell us who signs.</Trans>
	) : locked ? (
		task.locked_until_title ? (
			<Trans>Opens after you sign {task.locked_until_title}.</Trans>
		) : (
			<Trans>Opens after signing.</Trans>
		)
	) : done ? (
		<Trans>Done</Trans>
	) : when ? (
		<Trans>Sent {when}. We are on it.</Trans>
	) : (
		<Trans>We are on it.</Trans>
	);
	return (
		<Row testId={`task-${task.kind}`} data-status={task.status}>
			<Group gap="sm" wrap="nowrap" align="flex-start">
				<Box pt="xs" style={{ flexShrink: 0, lineHeight: 0 }}>
					{icon}
				</Box>
				<Stack gap="xs" style={{ minWidth: 0 }}>
					<Text c={done ? "dimmed" : undefined}>{title}</Text>
					<Text size="sm" c="dimmed">
						{note}
					</Text>
				</Stack>
			</Group>
		</Row>
	);
}

/**
 * Where an onboarding step is taken: the demo project, the tutorial, a new project in
 * their workspace, the booking dialog. Without the place (no workspace yet), the step
 * shows its words and no button.
 */
function OnboardingAction({
	task,
	orgId,
	variant,
	onBookCall,
}: {
	task: TaskT;
	orgId: string;
	variant: "filled" | "outline";
	onBookCall: () => void;
}) {
	const { language } = useParams<{ language?: string }>();
	const queryClient = useQueryClient();
	const workspace = task.params?.workspace_id;
	const link = (to: string, label: ReactNode) => (
		<Button
			variant={variant}
			component={I18nLink}
			to={to}
			data-testid={`action-${task.code}`}
		>
			{label}
		</Button>
	);
	switch (task.code) {
		case "explore_demo":
			return workspace && task.params?.project_id
				? link(
						`/w/${workspace}/projects/${task.params.project_id}/overview`,
						<Trans>Open the demo</Trans>,
					)
				: null;
		case "watch_tutorial":
			// No one can tell a video was watched, so opening the tutorial from here is the
			// step. The documentation stands in until the tutorial video exists.
			return (
				<Button
					variant={variant}
					component="a"
					href={getDocumentationUrl(language)}
					target="_blank"
					rel="noopener noreferrer"
					onClick={() => {
						void call("tutorialOpened", { params: { orgId } })
							.then(() =>
								queryClient.invalidateQueries({ queryKey: accountKeys.all }),
							)
							.catch(() => {});
					}}
					data-testid="action-watch_tutorial"
				>
					<Trans>Open the tutorial</Trans>
				</Button>
			);
		case "create_project":
			return workspace
				? link(`/w/${workspace}/projects/new`, <Trans>New project</Trans>)
				: null;
		case "book_call":
			return (
				<Button
					variant={variant}
					onClick={onBookCall}
					data-testid="action-book_call"
				>
					<Trans>Book a call</Trans>
				</Button>
			);
		default:
			return null;
	}
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
	// Shown inside the modal, next to the file it is about, until the next try.
	const [error, setError] = useState<unknown>(null);
	const queryClient = useQueryClient();
	const needsFile = task?.kind === "upload";
	const taskId = task?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new task starts clean
	useEffect(() => setError(null), [taskId]);

	const submit = async () => {
		if (!task) return;
		setPending(true);
		setError(null);
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
			setError(e);
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
						<FileButton
							onChange={(f) => {
								setFile(f);
								setError(null);
							}}
						>
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
				{error ? <ErrorNotice error={error} /> : null}
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
