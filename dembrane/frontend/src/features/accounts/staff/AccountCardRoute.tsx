import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Container,
	CopyButton,
	Flex,
	Group,
	Loader,
	Menu,
	Modal,
	Paper,
	SegmentedControl,
	Select,
	Stack,
	Table,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { openPdf } from "../api/client";
import { useAccountCard, useAccountsMutation } from "../api/hooks";
import type {
	AccountCardT,
	DocumentSummaryT,
	TaskT,
} from "../contract/contract.gen";
import { deliveryFor, InvoiceDelivery } from "../customer/InvoiceDelivery";
import { Questions } from "../customer/Questions";
import {
	dealStageLabel,
	documentKindLabel,
	documentStatusColor,
	documentStatusLabel,
	formatDate,
	formatDateTime,
	formatMoney,
	stageLabel,
	taskStatusLabel,
	taskText,
} from "../format";
import { AccountsI18n } from "../i18n";
import { Section } from "../ui";
import {
	AcceptedOutsideModal,
	outsideViaLabel,
	VoidAcceptanceModal,
} from "./AcceptedOutsideModals";
import { EmailCustomerModal, type EmailSubject } from "./EmailCustomerModal";
import { PushOfferModal } from "./PushOfferModal";
import { NewTaskModal, SendBackModal } from "./TaskModals";
import { UploadPdfModal } from "./UploadPdfModal";

/**
 * Staff: one organisation's account. The work (documents, tasks, questions) on the left,
 * what we know about them (stage, needs form, demo, billing, timeline) on the right.
 */
export const AccountCardRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<Card />
		</StaffOnly>
	</AccountsI18n>
);

export function StaffOnly({ children }: { children: React.ReactNode }) {
	const { data: me, isLoading } = useV2Me();
	if (isLoading) return null;
	if (me?.is_staff !== true) {
		return (
			<Container size="sm" py="xl">
				<Text c="dimmed" ta="center">
					<Trans>This area is for dembrane staff.</Trans>
				</Text>
			</Container>
		);
	}
	return <>{children}</>;
}

function Card() {
	const { orgId } = useParams<{ orgId: string }>();
	const { data, isLoading, error } = useAccountCard(orgId);
	useDocumentTitle(
		data ? `${data.organisation.name} | Accounts` : t`Accounts | dembrane`,
	);
	if (isLoading) return <Loader m="xl" size="sm" />;
	if (error || !data || !orgId) {
		return (
			<Container size="sm" py="xl">
				<Alert color="red">
					<Trans>This account could not be loaded.</Trans>
				</Alert>
			</Container>
		);
	}
	return (
		<Container size="xl" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap="lg">
				<Stack gap={4}>
					<Anchor
						component={I18nLink}
						to="/admin/accounts"
						size="sm"
						c="dimmed"
					>
						<Group gap={4}>
							<ArrowLeftIcon size={14} />
							<Trans>Accounts</Trans>
						</Group>
					</Anchor>
					<Group justify="space-between" align="flex-start" gap="sm">
						<Group gap="xs">
							<Title order={3}>{data.organisation.name}</Title>
							{data.organisation.deal_stage && (
								<Badge
									size="sm"
									variant="light"
									color="gray"
									data-testid="account-deal-stage"
								>
									{dealStageLabel(data.organisation.deal_stage)}
								</Badge>
							)}
						</Group>
						<UpgradeAccount card={data} />
					</Group>
				</Stack>
				<Milestones card={data} />
				{/* Flex, not Grid: Grid would join the shared Mantine chunk the portal loads. */}
				<Flex
					direction={{ base: "column", md: "row" }}
					gap="xl"
					align="flex-start"
				>
					<Box
						w={{ base: "100%", md: "auto" }}
						style={{ flex: 2, minWidth: 0 }}
					>
						<Stack gap={32}>
							<Documents orgId={orgId} card={data} />
							<Tasks orgId={orgId} card={data} />
							<Questions orgId={orgId} tickets={data.tickets} side="staff" />
						</Stack>
					</Box>
					<Box
						w={{ base: "100%", md: "auto" }}
						style={{ flex: 1, minWidth: 0 }}
					>
						<Stack gap={28}>
							{data.organisation.account_stage !== null && (
								<Stage orgId={orgId} card={data} />
							)}
							<NeedsForm card={data} />
							<Billing card={data} />
							<Timeline card={data} />
						</Stack>
					</Box>
				</Flex>
			</Stack>
		</Container>
	);
}

function Documents({ orgId, card }: { orgId: string; card: AccountCardT }) {
	const { i18n } = useLingui();
	const [offerOpen, setOfferOpen] = useState(false);
	const [uploadOpen, setUploadOpen] = useState(false);
	const navigate = useI18nNavigate();
	const send = useAccountsMutation("sendDocument", { orgId });
	const voidDoc = useAccountsMutation("voidDocument", { orgId });
	const [emailing, setEmailing] = useState<EmailSubject | null>(null);
	const [accepting, setAccepting] = useState<DocumentSummaryT | null>(null);
	const [voiding, setVoiding] = useState<string | null>(null);

	const actions = (doc: DocumentSummaryT) => (
		<Menu position="bottom-end" withinPortal>
			<Menu.Target>
				<UnstyledButton aria-label={t`Actions`} p={4}>
					<DotsThreeIcon size={18} />
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				{doc.status === "draft" && doc.kind === "offer" && (
					<Menu.Item
						onClick={() =>
							navigate(`/admin/accounts/${orgId}/documents/${doc.id}`)
						}
					>
						<Trans>Review and send</Trans>
					</Menu.Item>
				)}
				{doc.kind === "offer" &&
					["sent", "viewed", "declined"].includes(doc.status) && (
						<Menu.Item
							onClick={() =>
								navigate(
									`/admin/accounts/${orgId}/documents/${doc.id}?revise=1`,
								)
							}
							data-testid="doc-revise"
						>
							<Trans>Revise</Trans>
						</Menu.Item>
					)}
				{doc.status === "draft" &&
					doc.kind !== "offer" &&
					doc.requires_signature && (
						<Menu.Item
							onClick={() =>
								navigate(`/admin/accounts/${orgId}/documents/${doc.id}/fields`)
							}
						>
							<Trans>Place fields</Trans>
						</Menu.Item>
					)}
				{doc.status === "draft" && !doc.requires_signature && (
					<Menu.Item
						onClick={() =>
							send.mutate(
								{ params: { docId: doc.id } },
								{
									onError: (e) => void notifyError(e),
									onSuccess: () => toast.success(t`Sent`),
								},
							)
						}
					>
						<Trans>Send</Trans>
					</Menu.Item>
				)}
				{(doc.kind === "offer" || doc.kind === "dpa") &&
					doc.requires_signature &&
					["sent", "viewed"].includes(doc.status) && (
						<Menu.Item
							onClick={() => setAccepting(doc)}
							data-testid="doc-accepted-outside"
						>
							{doc.kind === "dpa" ? (
								<Trans>Signed outside dembrane</Trans>
							) : (
								<Trans>Accepted outside dembrane</Trans>
							)}
						</Menu.Item>
					)}
				{doc.file_url && (
					<Menu.Item onClick={() => void openPdf(doc.file_url as string)}>
						<Trans>Open PDF</Trans>
					</Menu.Item>
				)}
				{doc.signed_pdf_url && (
					<Menu.Item onClick={() => void openPdf(doc.signed_pdf_url as string)}>
						<Trans>Open signed PDF</Trans>
					</Menu.Item>
				)}
				{doc.status !== "signed" &&
					doc.status !== "void" &&
					doc.kind !== "invoice" && (
						<Menu.Item
							color="red"
							onClick={() =>
								voidDoc.mutate(
									{ body: { reason: null }, params: { docId: doc.id } },
									{ onSuccess: () => toast.success(t`Withdrawn`) },
								)
							}
						>
							<Trans>Withdraw</Trans>
						</Menu.Item>
					)}
				{doc.accepted_outside && doc.status === "signed" && (
					<Menu.Item
						color="red"
						onClick={() => setVoiding(doc.id)}
						data-testid="doc-void-acceptance"
					>
						<Trans>Void acceptance</Trans>
					</Menu.Item>
				)}
				{doc.status === "void" && doc.sent_at && (
					<Menu.Item
						onClick={() =>
							setEmailing({
								document_id: doc.id,
								kind: "document_withdrawn",
								label: doc.title,
							})
						}
					>
						<Trans>Email the customer</Trans>
					</Menu.Item>
				)}
			</Menu.Dropdown>
		</Menu>
	);

	return (
		<Section
			title={<Trans>Documents</Trans>}
			testId="staff-documents"
			action={
				card.organisation.account_stage !== null && (
					<Group gap="xs">
						<Button
							size="xs"
							variant="default"
							onClick={() => setUploadOpen(true)}
							data-testid="upload-pdf"
						>
							<Trans>Upload PDF</Trans>
						</Button>
						<Button
							size="xs"
							onClick={() => setOfferOpen(true)}
							data-testid="push-offer"
						>
							<Trans>Push offer</Trans>
						</Button>
					</Group>
				)
			}
		>
			{card.invoice_waits.map((w) => (
				<Text key={w.document_id} size="sm" mb="xs" data-testid="invoice-waits">
					{invoiceWaitText(w.waits_for)}
					<Text span c="dimmed" size="sm">
						{" "}
						· {card.documents.find((d) => d.id === w.document_id)?.title}
					</Text>
				</Text>
			))}
			{card.documents.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>No documents yet.</Trans>
				</Text>
			) : (
				<Table verticalSpacing="xs" layout="fixed">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Document</Trans>
							</Table.Th>
							<Table.Th w={110}>
								<Trans>Status</Trans>
							</Table.Th>
							<Table.Th w={110} ta="right" visibleFrom="sm">
								<Trans>Amount</Trans>
							</Table.Th>
							<Table.Th w={44} />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{card.documents.map((doc) => (
							<Table.Tr
								key={doc.id}
								data-testid="staff-doc"
								data-status={doc.status}
							>
								<Table.Td>
									{doc.file_url ? (
										<Anchor
											component={I18nLink}
											to={`/admin/accounts/${orgId}/documents/${doc.id}`}
											size="sm"
											c="inherit"
											truncate
											display="block"
											data-testid="staff-doc-open"
										>
											{doc.title}
										</Anchor>
									) : (
										<Text size="sm" truncate>
											{doc.title}
										</Text>
									)}
									<Text size="xs" c="dimmed" truncate>
										{documentKindLabel(doc.kind)} ·{" "}
										{doc.version > 1 && `${t`Version ${doc.version}`} · `}
										{formatDate(doc.signed_at ?? doc.sent_at, i18n.locale) ||
											t`Not sent`}
										{doc.accepted_outside
											? ` · ${outsideViaLabel(doc.accepted_outside.via)}`
											: doc.signer?.email
												? ` · ${doc.signer.email}`
												: ""}
									</Text>
								</Table.Td>
								<Table.Td>
									<Badge
										size="sm"
										variant="light"
										color={documentStatusColor(doc)}
									>
										{doc.status === "draft"
											? t`Draft`
											: documentStatusLabel(doc)}
									</Badge>
								</Table.Td>
								<Table.Td ta="right" visibleFrom="sm">
									<Text size="sm">
										{formatMoney(doc.total_cents, doc.currency, i18n.locale)}
									</Text>
								</Table.Td>
								<Table.Td>{actions(doc)}</Table.Td>
							</Table.Tr>
						))}
					</Table.Tbody>
				</Table>
			)}
			<PushOfferModal
				opened={offerOpen}
				onClose={() => setOfferOpen(false)}
				orgId={orgId}
				orgName={card.organisation.name}
				onDraft={(docId) =>
					navigate(`/admin/accounts/${orgId}/documents/${docId}`)
				}
			/>
			<UploadPdfModal
				opened={uploadOpen}
				onClose={() => setUploadOpen(false)}
				orgId={orgId}
				onDraft={(docId) =>
					navigate(`/admin/accounts/${orgId}/documents/${docId}/fields`)
				}
			/>
			<EmailCustomerModal
				subject={emailing}
				onClose={() => setEmailing(null)}
				orgId={orgId}
			/>
			{accepting && (
				<AcceptedOutsideModal
					opened
					onClose={() => setAccepting(null)}
					orgId={orgId}
					doc={accepting}
				/>
			)}
			{voiding && (
				<VoidAcceptanceModal
					opened
					onClose={() => setVoiding(null)}
					orgId={orgId}
					docId={voiding}
				/>
			)}
		</Section>
	);
}

function Tasks({ orgId, card }: { orgId: string; card: AccountCardT }) {
	const { i18n } = useLingui();
	const [newOpen, setNewOpen] = useState(false);
	const [sendingBack, setSendingBack] = useState<TaskT | null>(null);
	const [emailing, setEmailing] = useState<EmailSubject | null>(null);
	const review = useAccountsMutation("reviewTask", { orgId });
	const decide = (task: TaskT, decision: "approve" | "withdraw") =>
		review.mutate(
			{ body: { decision, note: null }, params: { taskId: task.id } },
			{ onError: (e) => void notifyError(e) },
		);

	return (
		<Section
			title={<Trans>Tasks</Trans>}
			testId="staff-tasks"
			action={
				card.organisation.account_stage !== null && (
					<Button
						size="xs"
						variant="default"
						onClick={() => setNewOpen(true)}
						data-testid="new-task"
					>
						<Trans>New task</Trans>
					</Button>
				)
			}
		>
			{card.tasks.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>No tasks.</Trans>
				</Text>
			) : (
				<Table verticalSpacing="xs" layout="fixed">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Task</Trans>
							</Table.Th>
							<Table.Th w={150} visibleFrom="sm">
								<Trans>Status</Trans>
							</Table.Th>
							<Table.Th w={{ base: 120, sm: 190 }} />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{card.tasks.map((task) => (
							<Table.Tr
								key={task.id}
								data-testid="staff-task"
								data-status={task.status}
							>
								<Table.Td>
									<Text size="sm" truncate>
										{taskText(task).title}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{task.status === "submitted"
											? [task.response_text, task.response_file_name]
													.filter(Boolean)
													.join(" · ") || t`Submitted`
											: task.next_reminder_at
												? t`Check-in due ${formatDate(task.next_reminder_at, i18n.locale)}`
												: (task.review_note ?? "")}
									</Text>
									{/* On a phone the status sits under the title. */}
									<Badge
										hiddenFrom="sm"
										size="xs"
										variant="light"
										color={task.status === "submitted" ? "blue" : "gray"}
										mt={2}
									>
										{taskStatusLabel(task.status)}
									</Badge>
								</Table.Td>
								<Table.Td visibleFrom="sm">
									<Badge
										size="sm"
										variant="light"
										color={
											task.status === "submitted"
												? "blue"
												: task.status === "done"
													? "green"
													: "gray"
										}
									>
										{taskStatusLabel(task.status)}
									</Badge>
								</Table.Td>
								<Table.Td>
									<Group gap={4} justify="flex-end">
										{task.status === "submitted" && (
											<>
												<Button
													size="compact-xs"
													variant="default"
													onClick={() => setSendingBack(task)}
												>
													<Trans>Send back</Trans>
												</Button>
												<Button
													size="compact-xs"
													onClick={() => decide(task, "approve")}
													data-testid="task-approve"
												>
													<Trans>Approve</Trans>
												</Button>
											</>
										)}
										{(task.status === "open" ||
											task.status === "changes_requested") && (
											<Button
												size="compact-xs"
												variant="default"
												onClick={() =>
													setEmailing({
														kind: "task_reminder",
														label: taskText(task).title,
														task_id: task.id,
													})
												}
											>
												<Trans>Remind</Trans>
											</Button>
										)}
										{(task.status === "open" ||
											task.status === "locked" ||
											task.status === "changes_requested") && (
											<Button
												size="compact-xs"
												variant="subtle"
												color="gray"
												onClick={() => decide(task, "withdraw")}
											>
												<Trans>Withdraw</Trans>
											</Button>
										)}
									</Group>
								</Table.Td>
							</Table.Tr>
						))}
					</Table.Tbody>
				</Table>
			)}
			<NewTaskModal
				opened={newOpen}
				onClose={() => setNewOpen(false)}
				orgId={orgId}
				documents={card.documents}
			/>
			<SendBackModal
				task={sendingBack}
				onClose={() => setSendingBack(null)}
				orgId={orgId}
			/>
			<EmailCustomerModal
				subject={emailing}
				onClose={() => setEmailing(null)}
				orgId={orgId}
			/>
		</Section>
	);
}

/** The steps of the deal under the same names as the accounts list, each with its day. */
function Milestones({ card }: { card: AccountCardT }) {
	const { i18n } = useLingui();
	const m = card.organisation.milestones;
	const steps: [string, string | null][] = [
		[dealStageLabel("offer_drafted"), m.offer_drafted],
		[dealStageLabel("offer_sent"), m.offer_sent],
		[t`Signed`, m.signed],
		[t`Billing details`, m.billing_details],
		[t`Documents`, m.documents_signed],
		[dealStageLabel("invoice_sent"), m.invoice_sent],
	];
	return (
		<Group gap="xl" data-testid="account-milestones">
			{steps.map(([label, at]) => (
				<Stack key={label} gap={0}>
					<Text size="xs" c="dimmed">
						{label}
					</Text>
					<Text size="sm" c={at ? undefined : "dimmed"}>
						{at ? formatDate(at, i18n.locale) : "·"}
					</Text>
				</Stack>
			))}
		</Group>
	);
}

const PLANS = [
	["innovator", "Innovator"],
	["changemaker", "Changemaker"],
	["guardian", "Guardian"],
] as const;

/**
 * Staff do not switch an account on from here any more: the plan is asked of sam in
 * #team-customer_support, in the open, so the team sees who asked for which plan and when.
 */
function UpgradeAccount({ card }: { card: AccountCardT }) {
	const [opened, setOpened] = useState(false);
	const [plan, setPlan] = useState<string>("changemaker");
	const name = PLANS.find(([value]) => value === plan)?.[1] ?? plan;
	// The plan, seats and end date come from the deal, so the message names the signed offer;
	// without one sam asks why before it changes anything.
	const offer = card.documents
		.filter((d) => d.kind === "offer" && d.status === "signed")
		.sort((a, b) => (b.signed_at ?? "").localeCompare(a.signed_at ?? ""))[0];
	const deal = offer?.reference ? `for ${offer.reference}` : "(no signed offer)";
	const message = `@sam upgrade ${card.organisation.name} to ${name} ${deal}: ${window.location.origin}/admin/accounts/${card.organisation.id}`;
	return (
		<>
			<Button
				size="xs"
				variant="default"
				onClick={() => setOpened(true)}
				data-testid="upgrade-account"
			>
				<Trans>Upgrade account</Trans>
			</Button>
			<Modal
				opened={opened}
				onClose={() => setOpened(false)}
				title={t`Upgrade this account`}
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							Copy this message and paste it in #team-customer_support.
						</Trans>
					</Text>
					<Group gap="sm">
						<Text size="sm">
							<Trans>Plan</Trans>
						</Text>
						<SegmentedControl
							size="xs"
							value={plan}
							onChange={setPlan}
							data={PLANS.map(([value, label]) => ({ label, value }))}
						/>
					</Group>
					<Paper withBorder radius="sm" p="sm">
						<Text
							size="sm"
							style={{ overflowWrap: "anywhere" }}
							data-testid="upgrade-message"
						>
							{message}
						</Text>
					</Paper>
					<Group justify="flex-end">
						<CopyButton value={message}>
							{({ copied, copy }) => (
								<Button onClick={copy} data-testid="upgrade-copy">
									{copied ? <Trans>Copied</Trans> : <Trans>Copy message</Trans>}
								</Button>
							)}
						</CopyButton>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}

function Stage({ orgId, card }: { orgId: string; card: AccountCardT }) {
	const update = useAccountsMutation("updateAccount", { orgId });
	return (
		<Section title={<Trans>Customer status</Trans>}>
			<Select
				aria-label={t`Customer status`}
				value={card.organisation.account_stage}
				onChange={(v) =>
					v &&
					update.mutate(
						{
							body: { account_stage: v as "prospect" | "customer" | "churned" },
						},
						{ onSuccess: () => toast.success(t`Stage set`) },
					)
				}
				data={["prospect", "customer", "churned"].map((s) => ({
					label: stageLabel(s),
					value: s,
				}))}
				allowDeselect={false}
				maw={220}
			/>
		</Section>
	);
}

/** Pairs from the needs form answers, whatever their shape: strings, lists or nested objects. */
const entries = (value: unknown): [string, string][] => {
	if (!value || typeof value !== "object") return [];
	return Object.entries(value as Record<string, unknown>).map(([k, v]) => [
		k.replace(/_/g, " "),
		Array.isArray(v)
			? v.join(", ")
			: typeof v === "object" && v !== null
				? JSON.stringify(v)
				: String(v),
	]);
};

/** Every http(s) link inside the demo record the seed printed. */
const links = (value: unknown, out: string[] = []): string[] => {
	if (typeof value === "string" && /^https?:\/\//.test(value)) out.push(value);
	else if (value && typeof value === "object")
		for (const v of Object.values(value)) links(v, out);
	return out;
};

const KeyValues = ({
	rows,
}: {
	rows: [React.ReactNode, React.ReactNode][];
}) => (
	<Stack gap={6}>
		{rows.map(([k, v], i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: rows are rebuilt from the card on every render, never reordered
			<Group key={i} gap="xs" wrap="nowrap" align="flex-start">
				<Text
					size="xs"
					c="dimmed"
					w={110}
					style={{ flexShrink: 0, textTransform: "capitalize" }}
				>
					{k}
				</Text>
				<Text size="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
					{v}
				</Text>
			</Group>
		))}
	</Stack>
);

function NeedsForm({ card }: { card: AccountCardT }) {
	const nf = card.needs_form;
	const demoLinks = links(card.demo);
	return (
		<Section title={<Trans>Needs form and demo</Trans>} testId="needs-form">
			{!nf && demoLinks.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>No needs form or demo linked.</Trans>
				</Text>
			) : (
				<KeyValues
					rows={[
						...(nf
							? ([
									[t`Reference`, nf.reference ?? ""],
									[t`Email`, nf.email ?? ""],
									[t`Call`, nf.booking_status ?? t`Not booked`],
									...entries(nf.answers),
									...entries(nf.config),
								] as [string, string][])
							: []),
						...demoLinks.map(
							(href) =>
								[
									t`Demo`,
									<Anchor
										key={href}
										href={href}
										target="_blank"
										rel="noreferrer"
										size="sm"
									>
										{href.replace(/^https?:\/\//, "")}
									</Anchor>,
								] as [string, React.ReactNode],
						),
					]}
				/>
			)}
		</Section>
	);
}

function Billing({ card }: { card: AccountCardT }) {
	const b = card.billing;
	const update = useAccountsMutation("updateAccount", {
		orgId: card.organisation.id,
	});
	const address = [
		b.address_line1,
		b.address_line2,
		[b.postal_code, b.city].filter(Boolean).join(" "),
		b.country,
	]
		.filter(Boolean)
		.join(", ");
	const rows: [string, string][] = (
		[
			[t`Legal name`, b.legal_name],
			[t`Invoice email`, b.billing_email],
			[t`Address`, address],
			[
				t`VAT number`,
				b.no_vat_number ? t`The customer has no VAT number` : b.vat_id,
			],
			[t`KvK number`, b.kvk_number],
			[t`KBO number`, b.kbo_number],
			[t`PO number`, b.po_number],
			[t`Peppol ID`, b.peppol_id],
		] as [string, string | null][]
	).filter((r): r is [string, string] => Boolean(r[1]));
	return (
		<Section title={<Trans>Billing details</Trans>} testId="staff-billing">
			<Stack gap="sm">
				{/* Staff can opt a customer out of Peppol too, or back in; another way is the customer's to change. */}
				<InvoiceDelivery
					side="staff"
					match={b.peppol_match}
					delivery={deliveryFor(b.peppol_match, b.invoice_delivery)}
					email={b.billing_email}
					onChange={(next) =>
						update.mutate({ body: { invoice_delivery: next } })
					}
					disabled={update.isPending}
				/>
				{rows.length === 0 ? (
					<Text size="sm" c="dimmed">
						<Trans>Not given yet.</Trans>
					</Text>
				) : (
					<KeyValues rows={rows} />
				)}
			</Stack>
		</Section>
	);
}

/** What an accepted offer's invoice still waits for, as one sentence. */
const invoiceWaitText = (waits: readonly string[]): string =>
	waits.includes("billing_details") && waits.includes("dpa")
		? t`Invoice waits for the billing details and the DPA signature`
		: waits.includes("dpa")
			? t`Invoice waits for the DPA signature`
			: t`Invoice waits for the billing details`;

const eventLabel = (type: string): string =>
	({
		"account.created": t`Account created`,
		"account.enabled": t`Account enabled`,
		"account.stage_set": t`Stage set`,
		"account.updated": t`Account updated`,
		"billing_details.updated": t`Billing details updated`,
		"booking.recorded": t`Call booked`,
		"demo.opened": t`Demo opened by staff`,
		"demo.published": t`Demo published`,
		"demo.seeded": t`Demo seeded`,
		"demo.unpublished": t`Demo unpublished`,
		"document.acceptance_voided": t`Acceptance voided`,
		"document.accepted_outside": t`Accepted outside dembrane`,
		"document.declined": t`Document declined`,
		"document.drafted": t`Document drafted`,
		"document.fields_set": t`Signature fields placed`,
		"document.sent": t`Document sent`,
		"document.signed": t`Document signed`,
		"document.signed_outside": t`Signed outside dembrane`,
		"document.signer_named": t`Signer named`,
		"document.signer_reminded": t`Signer reminded`,
		"document.signer_replaced": t`Signer replaced`,
		"document.updated": t`Draft changed`,
		"document.viewed": t`Document viewed`,
		"document.voided": t`Document withdrawn`,
		"invoice.created": t`Invoice added`,
		"invoice.requested": t`Ready to invoice`,
		"message.sent": t`Customer emailed`,
		"onboarding.added": t`Onboarding tasks added`,
		"onboarding.withdrawn": t`Onboarding tasks withdrawn`,
		"task.approve": t`Task approved`,
		"task.approved": t`Task approved`,
		"task.check_in_asked": t`Account manager asked to check in`,
		"task.created": t`Task created`,
		"task.done": t`Task done`,
		"task.send_back": t`Task sent back`,
		"task.sent_back": t`Task sent back`,
		"task.submitted": t`Task submitted`,
		"task.withdraw": t`Task withdrawn`,
		"task.withdrawn": t`Task withdrawn`,
		"ticket.closed": t`Question closed`,
		"ticket.opened": t`Question opened`,
		"ticket.replied": t`Question answered`,
	})[type] ?? type;

/** An invoice part's subject is its offer's id and the part's number: the offer's id. */
const subjectDocument = (id: string | null) => id?.split(":")[0] ?? null;

/** ", part 2 of 3" after the offer, for the request of one part of its invoice. */
const partOf = (detail: unknown) => {
	const d = detail as { part?: number; of?: number } | null;
	return d?.part && d.of ? `, ${t`part ${d.part} of ${d.of}`}` : null;
};

function Timeline({ card }: { card: AccountCardT }) {
	const { i18n } = useLingui();
	const [all, setAll] = useState(false);
	const events = all ? card.timeline : card.timeline.slice(0, 8);
	const title = (id: string | null) =>
		card.documents.find((d) => d.id === id)?.title ??
		(() => {
			const x = card.tasks.find((y) => y.id === id);
			return x ? taskText(x).title : undefined;
		})();
	return (
		<Section title={<Trans>Timeline</Trans>} testId="timeline">
			<Paper withBorder radius="md" p="sm">
				<Stack gap={8}>
					{events.map((e) => (
						<Stack key={e.id} gap={0}>
							<Text size="sm">
								{e.type === "invoice.waiting"
									? invoiceWaitText(
											(e.detail as { waits_for?: string[] } | null)
												?.waits_for ?? [],
										)
									: eventLabel(e.type)}
								{title(subjectDocument(e.subject_id)) ? (
									<Text span c="dimmed" size="sm">
										{" "}
										· {title(subjectDocument(e.subject_id))}
										{partOf(e.detail)}
									</Text>
								) : null}
							</Text>
							<Text size="xs" c="dimmed">
								{formatDateTime(e.created_at, i18n.locale)} ·{" "}
								{e.actor === "customer"
									? t`Customer`
									: e.actor === "staff"
										? (e.actor_name ?? t`Staff`)
										: t`System`}
							</Text>
						</Stack>
					))}
					{card.timeline.length > 8 && (
						<Anchor
							component="button"
							size="xs"
							ta="left"
							onClick={() => setAll((v) => !v)}
						>
							{all ? <Trans>Show less</Trans> : <Trans>Show all</Trans>}
						</Anchor>
					)}
				</Stack>
			</Paper>
		</Section>
	);
}
