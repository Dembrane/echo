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
	Flex,
	Group,
	Loader,
	Menu,
	Paper,
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
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { openPdf } from "../api/client";
import { useAccountCard, useAccountsMutation } from "../api/hooks";
import type {
	AccountCardT,
	DocumentSummaryT,
	TaskT,
} from "../contract/contract.gen";
import { Questions } from "../customer/Questions";
import {
	documentKindLabel,
	documentStatusColor,
	documentStatusLabel,
	formatDate,
	formatDateTime,
	formatMoney,
	stageLabel,
	taskStatusLabel,
} from "../format";
import { AccountsI18n } from "../i18n";
import { Section } from "../ui";
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
					<Title order={3} fw={400}>
						{data.organisation.name}
					</Title>
				</Stack>
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
							<Stage orgId={orgId} card={data} />
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

	const actions = (doc: DocumentSummaryT) => (
		<Menu position="bottom-end" withinPortal>
			<Menu.Target>
				<UnstyledButton aria-label={t`Actions`} p={4}>
					<DotsThreeIcon size={18} />
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				{doc.status === "draft" && doc.requires_signature && (
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
									onError: (e) => toast.error(e.message),
									onSuccess: () => toast.success(t`Sent`),
								},
							)
						}
					>
						<Trans>Send</Trans>
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
			</Menu.Dropdown>
		</Menu>
	);

	return (
		<Section
			title={<Trans>Documents</Trans>}
			testId="staff-documents"
			action={
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
			}
		>
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
									<Text size="sm" truncate>
										{doc.title}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{documentKindLabel(doc.kind)} ·{" "}
										{formatDate(doc.signed_at ?? doc.sent_at, i18n.locale) ||
											t`Not sent`}
										{doc.signer?.email ? ` · ${doc.signer.email}` : ""}
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
			/>
			<UploadPdfModal
				opened={uploadOpen}
				onClose={() => setUploadOpen(false)}
				orgId={orgId}
				onDraft={(docId) =>
					navigate(`/admin/accounts/${orgId}/documents/${docId}/fields`)
				}
			/>
		</Section>
	);
}

function Tasks({ orgId, card }: { orgId: string; card: AccountCardT }) {
	const { i18n } = useLingui();
	const [newOpen, setNewOpen] = useState(false);
	const [sendingBack, setSendingBack] = useState<TaskT | null>(null);
	const review = useAccountsMutation("reviewTask", { orgId });
	const decide = (task: TaskT, decision: "approve" | "withdraw") =>
		review.mutate(
			{ body: { decision, note: null }, params: { taskId: task.id } },
			{ onError: (e) => toast.error(e.message) },
		);

	return (
		<Section
			title={<Trans>Tasks</Trans>}
			testId="staff-tasks"
			action={
				<Button
					size="xs"
					variant="default"
					onClick={() => setNewOpen(true)}
					data-testid="new-task"
				>
					<Trans>New task</Trans>
				</Button>
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
										{task.title}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{task.status === "submitted"
											? [task.response_text, task.response_file_name]
													.filter(Boolean)
													.join(" · ") || t`Submitted`
											: task.next_reminder_at
												? t`Next reminder ${formatDate(task.next_reminder_at, i18n.locale)}`
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
		</Section>
	);
}

function Stage({ orgId, card }: { orgId: string; card: AccountCardT }) {
	const update = useAccountsMutation("updateAccount", { orgId });
	return (
		<Section title={<Trans>Stage</Trans>}>
			<Select
				aria-label={t`Stage`}
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
			[t`VAT number`, b.vat_id],
			[t`KvK number`, b.kvk_number],
			[t`KBO number`, b.kbo_number],
			[t`PO number`, b.po_number],
			[t`Peppol ID`, b.peppol_id],
		] as [string, string | null][]
	).filter((r): r is [string, string] => Boolean(r[1]));
	return (
		<Section title={<Trans>Billing details</Trans>} testId="staff-billing">
			{rows.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>Not given yet.</Trans>
				</Text>
			) : (
				<KeyValues rows={rows} />
			)}
		</Section>
	);
}

const eventLabel = (type: string): string =>
	({
		"account.created": t`Account created`,
		"account.stage_set": t`Stage set`,
		"billing_details.updated": t`Billing details updated`,
		"booking.recorded": t`Call booked`,
		"demo.seeded": t`Demo seeded`,
		"document.declined": t`Document declined`,
		"document.drafted": t`Document drafted`,
		"document.sent": t`Document sent`,
		"document.signed": t`Document signed`,
		"document.signer_named": t`Signer named`,
		"document.viewed": t`Document viewed`,
		"document.voided": t`Document withdrawn`,
		"task.approve": t`Task approved`,
		"task.created": t`Task created`,
		"task.send_back": t`Task sent back`,
		"task.submitted": t`Task submitted`,
		"task.withdraw": t`Task withdrawn`,
		"ticket.opened": t`Question opened`,
	})[type] ?? type;

function Timeline({ card }: { card: AccountCardT }) {
	const { i18n } = useLingui();
	const [all, setAll] = useState(false);
	const events = all ? card.timeline : card.timeline.slice(0, 8);
	const title = (id: string | null) =>
		card.documents.find((d) => d.id === id)?.title ??
		card.tasks.find((x) => x.id === id)?.title;
	return (
		<Section title={<Trans>Timeline</Trans>} testId="timeline">
			<Paper withBorder radius="md" p="sm">
				<Stack gap={8}>
					{events.map((e) => (
						<Stack key={e.id} gap={0}>
							<Text size="sm">
								{eventLabel(e.type)}
								{title(e.subject_id) ? (
									<Text span c="dimmed" size="sm">
										{" "}
										· {title(e.subject_id)}
									</Text>
								) : null}
							</Text>
							<Text size="xs" c="dimmed">
								{formatDateTime(e.created_at, i18n.locale)} ·{" "}
								{e.actor === "customer"
									? t`Customer`
									: e.actor === "staff"
										? t`Staff`
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
