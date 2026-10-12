import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	FileButton,
	Group,
	Modal,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { getDocumentationUrl } from "@/config";
import { call, submitTaskWithFile } from "../api/client";
import { accountKeys } from "../api/hooks";
import type { DocumentSummaryT, TaskT } from "../contract/contract.gen";
import { formatDate, formatMoney, taskText } from "../format";
import { PageSection, Rows } from "./PageSection";
import { PayLine, PayModal } from "./Pay";
import {
	type AccountPlan,
	isGetStarted,
	toDoInOrder,
	waitsOnWhoSigns,
} from "./plan";
import { mayRemind, RemindSigner } from "./RemindSigner";
import { SendToSomeoneElse } from "./SendToSomeoneElse";
import { Figure, KindIcon, kindOf, secondary, TaskLine } from "./TaskLine";
import { WhoSigns } from "./WhoSigns";

/**
 * What the customer has to do, then what is coming: tasks are a set, not a sequence, so
 * there are no step numbers. Every task is a task line (TaskLine): invoices to pay lead To
 * do, then the open tasks, each with its one blue pill. Coming up holds what waits on
 * someone else, on dembrane or on a signature, with secondary buttons only, and the
 * finished tasks folded away.
 */
export function NextSteps({
	orgId,
	plan,
	documents,
	today,
	onBilling,
	onBookCall,
}: {
	orgId: string;
	plan: Pick<
		AccountPlan,
		"toPay" | "toDo" | "waiting" | "withUs" | "later" | "done" | "withDpa"
	>;
	documents: DocumentSummaryT[];
	today: string;
	onBilling: () => void;
	onBookCall: () => void;
}) {
	const [responding, setResponding] = useState<TaskT | null>(null);
	const [sendingTo, setSendingTo] = useState<string | null>(null);
	const [asking, setAsking] = useState<TaskT | null>(null);
	const [paying, setPaying] = useState<DocumentSummaryT | null>(null);
	const [showDone, setShowDone] = useState(false);
	const { toPay, toDo, waiting, withUs, later, done, withDpa } = plan;
	const coming = [...withUs, ...later];
	const ahead = waiting.length + coming.length;
	const items = toDoInOrder(plan, documents);
	const starting = toDo.filter(isGetStarted);
	const docOf = (task: TaskT) =>
		documents.find((d) => d.id === task.document_id) ?? null;
	if (items.length + starting.length + ahead + done.length === 0) return null;
	const openTask = (task: TaskT, primary: boolean) => (
		<OpenTask
			key={task.id}
			task={task}
			primary={primary}
			doc={docOf(task)}
			withDpa={withDpa.has(task.id)}
			orgId={orgId}
			onBilling={onBilling}
			onBookCall={onBookCall}
			onRespond={() => setResponding(task)}
			onSendTo={() => setSendingTo(task.document_id)}
			onWhoSigns={() => setAsking(task)}
		/>
	);

	return (
		<>
			{items.length > 0 && (
				<PageSection
					title={<Trans>To do</Trans>}
					count={items.length}
					testId="next-steps"
				>
					{/* The first is next: the page's one blue pill. */}
					<Rows>
						{items.map((item, i) =>
							item.kind === "invoice" ? (
								<PayLine
									key={item.id}
									doc={item.doc}
									today={today}
									primary={i === 0}
									onPay={() => setPaying(item.doc)}
								/>
							) : (
								openTask(item.task, i === 0)
							),
						)}
					</Rows>
				</PageSection>
			)}

			{starting.length > 0 && (
				<PageSection
					title={<Trans>Get started</Trans>}
					count={<Trans>optional</Trans>}
					testId="get-started"
				>
					<Rows>{starting.map((task) => openTask(task, false))}</Rows>
				</PageSection>
			)}

			{(ahead > 0 || done.length > 0) && (
				<PageSection
					title={ahead > 0 ? <Trans>Coming up</Trans> : <Trans>Done</Trans>}
					count={ahead > 0 ? ahead : done.length}
					testId="coming-up"
					action={
						done.length > 0 && ahead > 0 ? (
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
					<Rows>
						{waiting.map(({ task, signer }) => (
							<WaitingTask
								key={task.id}
								task={task}
								doc={docOf(task)}
								withDpa={withDpa.has(task.id)}
								signer={signer}
								orgId={orgId}
								onSendTo={() => setSendingTo(task.document_id)}
							/>
						))}
						{coming.map((task) => (
							<QuietTask
								key={task.id}
								task={task}
								withDpa={withDpa.has(task.id)}
								afterWhoSigns={waitsOnWhoSigns(task, toDo)}
							/>
						))}
						{(showDone || ahead === 0) &&
							done.map((task) => <QuietTask key={task.id} task={task} />)}
					</Rows>
				</PageSection>
			)}

			<PayModal doc={paying} onClose={() => setPaying(null)} />
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
				current={documents.find((d) => d.id === sendingTo)?.signer ?? null}
				onClose={() => setSendingTo(null)}
			/>
		</>
	);
}

/** Facts for one line, set apart by a middle dot. */
const facts = (...parts: ReactNode[]) => {
	const shown = parts.filter(Boolean);
	if (shown.length === 0) return null;
	return shown.map((part, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list of facts
		<Fragment key={i}>
			{i > 0 && " · "}
			{part}
		</Fragment>
	));
};

/** The amount of a document to sign, when it has one, at the right of its line. */
function DocFigure({ doc }: { doc: DocumentSummaryT | null }) {
	const { i18n } = useLingui();
	if (doc?.total_cents == null) return null;
	const amount = formatMoney(doc.total_cents, doc.currency, i18n.locale);
	const vat = formatMoney(doc.vat_cents, doc.currency, i18n.locale);
	return (
		<Figure
			amount={amount}
			vat={
				doc.vat_cents != null && doc.vat_cents > 0 ? (
					<Trans>incl. {vat} VAT</Trans>
				) : undefined
			}
		/>
	);
}

function OpenTask({
	task,
	primary,
	doc,
	withDpa,
	orgId,
	onBilling,
	onBookCall,
	onRespond,
	onSendTo,
	onWhoSigns,
}: {
	task: TaskT;
	/** The next task: the page's one blue pill. Every other action is a secondary. */
	primary: boolean;
	doc: DocumentSummaryT | null;
	withDpa: boolean;
	orgId: string;
	onBilling: () => void;
	onBookCall: () => void;
	onRespond: () => void;
	onSendTo: () => void;
	onWhoSigns: () => void;
}) {
	const { i18n } = useLingui();
	const { title, body } = taskText(task);
	const action = primary ? ({ variant: "filled" } as const) : secondary;
	const sentBack = task.status === "changes_requested";
	const signing = task.kind === "sign" && task.document_id;
	const validUntil = formatDate(doc?.valid_until, i18n.locale);
	const due = formatDate(task.due_on, i18n.locale);

	// One fact under the title; the title already says what to do.
	const fact =
		sentBack && task.review_note ? (
			<Text span inherit c="var(--app-warning)">
				<Trans>We asked for a change: {task.review_note}</Trans>
			</Text>
		) : signing ? (
			facts(
				validUntil && <Trans>Valid until {validUntil}</Trans>,
				withDpa && <Trans>Includes the data processing agreement</Trans>,
			)
		) : task.code === "who_signs" ? (
			<Trans>3 questions</Trans>
		) : (
			facts(
				due && <Trans>Before {due}</Trans>,
				body && (
					<Text span inherit lineClamp={1}>
						{body}
					</Text>
				),
			)
		);

	const actions = (() => {
		if (signing) {
			// Signing is the pill and comes first; handing it on is the secondary.
			return (
				<>
					<Button
						{...action}
						component={I18nLink}
						to={`/o/${orgId}/account/documents/${task.document_id}/sign`}
						data-testid="action-sign"
					>
						<Trans>Review and sign</Trans>
					</Button>
					<Button
						{...secondary}
						onClick={onSendTo}
						data-testid="action-send-to"
					>
						<Trans>Send to someone else</Trans>
					</Button>
				</>
			);
		}
		if (task.code === "who_signs") {
			return (
				<Button {...action} onClick={onWhoSigns} data-testid="action-who-signs">
					<Trans>Choose who signs</Trans>
				</Button>
			);
		}
		if (isGetStarted(task)) {
			return (
				<OnboardingAction
					task={task}
					orgId={orgId}
					action={action}
					onBookCall={onBookCall}
				/>
			);
		}
		if (task.kind === "billing_details") {
			return (
				<Button {...action} onClick={onBilling} data-testid="action-billing">
					<Trans>Fill in billing details</Trans>
				</Button>
			);
		}
		return (
			<Button {...action} onClick={onRespond}>
				{task.kind === "upload" ? <Trans>Upload</Trans> : <Trans>Reply</Trans>}
			</Button>
		);
	})();

	return (
		<TaskLine
			testId={`task-${task.kind}`}
			data-status={task.status}
			marker={<KindIcon kind={kindOf(task)} />}
			title={title}
			fact={fact}
			figure={signing ? <DocFigure doc={doc} /> : null}
			actions={actions}
		/>
	);
}

/** Days since someone was named to sign, from when they were named. */
const daysSince = (iso: string | null) =>
	iso == null ? null : Math.floor((Date.now() - Date.parse(iso)) / 864e5);

/**
 * A signature handed to someone else: it waits on them, and their signature completes it.
 * The line says how long it has waited; after a day the person can be reminded. The
 * document opens under the line to read along, and can be handed to someone else again.
 */
function WaitingTask({
	task,
	doc,
	withDpa,
	signer,
	orgId,
	onSendTo,
}: {
	task: TaskT;
	doc: DocumentSummaryT | null;
	withDpa: boolean;
	signer: NonNullable<DocumentSummaryT["signer"]>;
	orgId: string;
	onSendTo: () => void;
}) {
	const { title } = taskText(task);
	const who = signer.name || signer.email;
	const jobTitle = signer.role;
	const assignee = jobTitle ? `${who}, ${jobTitle}` : who;
	const days = daysSince(signer.named_at);
	const firstName = signer.name?.split(" ")[0] || signer.email;
	const waited =
		days == null ? null : days < 1 ? (
			<Trans>sent today</Trans>
		) : (
			<Plural value={days} one="# day" other="# days" />
		);
	return (
		<TaskLine
			testId="task-waiting"
			data-status="waiting"
			marker={<KindIcon kind={kindOf(task)} quiet />}
			title={title}
			fact={
				<span data-testid="waiting-on">
					{facts(
						<Trans>Waiting on {assignee}</Trans>,
						signer.email,
						waited,
						withDpa && <Trans>Includes the data processing agreement</Trans>,
					)}
				</span>
			}
			actions={
				<>
					{mayRemind(signer) && task.document_id && (
						<RemindSigner
							orgId={orgId}
							docId={task.document_id}
							name={firstName}
						/>
					)}
					{task.document_id && (
						// The document opens in its own window, read-only, saying whose it is.
						<Button
							{...secondary}
							component={I18nLink}
							to={`/o/${orgId}/account/documents/${task.document_id}/sign`}
							target="_blank"
							rel="noopener"
							rightSection={<ArrowSquareOutIcon size={16} aria-hidden />}
							data-testid="action-view-offer"
						>
							{doc?.kind === "dpa" ? (
								<Trans>View agreement</Trans>
							) : doc?.kind === "offer" ? (
								<Trans>View offer</Trans>
							) : (
								<Trans>View document</Trans>
							)}
						</Button>
					)}
					<Button
						{...secondary}
						onClick={onSendTo}
						data-testid="action-send-to"
					>
						<Trans>Send to someone else</Trans>
					</Button>
				</>
			}
		/>
	);
}

/** A task that is not the customer's move: with dembrane, waiting on a signature, or done. */
function QuietTask({
	task,
	withDpa = false,
	afterWhoSigns = false,
}: {
	task: TaskT;
	withDpa?: boolean;
	/** A signature that opens once the customer has said who signs. */
	afterWhoSigns?: boolean;
}) {
	const { i18n } = useLingui();
	const { title } = taskText(task);
	const locked = afterWhoSigns || task.locked || task.status === "locked";
	const done = task.status === "done";
	const when = formatDate(task.submitted_at, i18n.locale);
	const until = task.locked_until_title;
	const note = afterWhoSigns ? (
		<Trans>Opens after you tell us who signs</Trans>
	) : locked ? (
		until ? (
			<Trans>Opens after you sign {until}</Trans>
		) : (
			<Trans>Opens after signing</Trans>
		)
	) : done ? (
		<Trans>Done</Trans>
	) : when ? (
		<Trans>Sent {when}. We are on it.</Trans>
	) : (
		<Trans>We are on it.</Trans>
	);
	return (
		<TaskLine
			testId={`task-${task.kind}`}
			data-status={task.status}
			marker={<KindIcon kind={kindOf(task)} quiet />}
			title={
				done ? (
					<Text span inherit c="dimmed">
						{title}
					</Text>
				) : (
					title
				)
			}
			fact={facts(
				withDpa && <Trans>Includes the data processing agreement</Trans>,
				note,
			)}
		/>
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
	action,
	onBookCall,
}: {
	task: TaskT;
	orgId: string;
	/** The pill, or the secondary. */
	action: { variant: "filled" } | typeof secondary;
	onBookCall: () => void;
}) {
	const { language } = useParams<{ language?: string }>();
	const queryClient = useQueryClient();
	const workspace = task.params?.workspace_id;
	const link = (to: string, label: ReactNode) => (
		<Button
			{...action}
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
					{...action}
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
				<Button {...action} onClick={onBookCall} data-testid="action-book_call">
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
