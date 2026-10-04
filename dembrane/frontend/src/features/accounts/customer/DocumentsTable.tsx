import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Box,
	Button,
	CopyButton,
	Group,
	Modal,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import { Fragment, useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { usePdfHref } from "../api/hooks";
import type { DocumentSummaryT } from "../contract/contract.gen";
import {
	documentKindLabel,
	documentStatusColor,
	documentStatusLabel,
	documentTitle,
	formatDate,
	formatMoney,
} from "../format";
import { Section } from "../ui";

/** Offers, signed PDFs and invoices. Unpaid invoices carry the transfer details under them. */
export function DocumentsTable({
	orgId,
	documents,
}: {
	orgId: string;
	documents: DocumentSummaryT[];
}) {
	const { i18n } = useLingui();
	return (
		<Section title={<Trans>Documents</Trans>} testId="documents">
			{documents.length === 0 ? (
				<Text size="sm" c="dimmed">
					<Trans>No documents yet.</Trans>
				</Text>
			) : (
				<>
					{/* A phone gets a list: a four-column table does not fit next to the rail. */}
					<Stack gap={0} hiddenFrom="sm" data-testid="documents-list">
						{documents.map((doc) => (
							<Box
								key={doc.id}
								py="xs"
								style={{
									borderBottom: "1px solid var(--app-quiet)",
								}}
							>
								<Group
									justify="space-between"
									wrap={doc.invoice ? "wrap" : "nowrap"}
									align="flex-start"
									gap="xs"
								>
									<Stack gap={2} style={{ minWidth: 0 }}>
										<Text size="sm">{documentTitle(doc)}</Text>
										<Group gap={6}>
											<Badge
												variant="light"
												color={documentStatusColor(doc)}
												size="xs"
											>
												{documentStatusLabel(doc)}
											</Badge>
											<Text size="xs" c="dimmed">
												{formatMoney(
													doc.total_cents,
													doc.currency,
													i18n.locale,
												)}
											</Text>
										</Group>
									</Stack>
									<DocumentAction orgId={orgId} doc={doc} />
								</Group>
							</Box>
						))}
					</Stack>
					<Table
						verticalSpacing="xs"
						horizontalSpacing="xs"
						layout="fixed"
						visibleFrom="sm"
					>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Trans>Document</Trans>
								</Table.Th>
								<Table.Th w={110} visibleFrom="sm">
									<Trans>Status</Trans>
								</Table.Th>
								<Table.Th w={120} ta="right" visibleFrom="sm">
									<Trans>Amount</Trans>
								</Table.Th>
								<Table.Th w={{ base: 100, sm: 290 }} />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{documents.map((doc) => (
								<Fragment key={doc.id}>
									<Table.Tr data-testid={`doc-${doc.kind}`}>
										<Table.Td>
											<Text size="sm" lineClamp={2}>
												{documentTitle(doc)}
											</Text>
											{/* On a phone the status sits under the title: two columns fit. */}
											<Badge
												hiddenFrom="sm"
												variant="light"
												color={documentStatusColor(doc)}
												size="xs"
												my={2}
											>
												{documentStatusLabel(doc)}
											</Badge>
											<Text size="xs" c="dimmed" truncate>
												{documentKindLabel(doc.kind)} ·{" "}
												{formatDate(
													doc.signed_at ??
														doc.invoice?.issued_on ??
														doc.sent_at,
													i18n.locale,
												)}
												<Text span hiddenFrom="sm">
													{doc.total_cents != null &&
														` · ${formatMoney(doc.total_cents, doc.currency, i18n.locale)}`}
												</Text>
											</Text>
										</Table.Td>
										<Table.Td visibleFrom="sm">
											<Badge
												variant="light"
												color={documentStatusColor(doc)}
												size="sm"
											>
												{documentStatusLabel(doc)}
											</Badge>
										</Table.Td>
										<Table.Td ta="right" visibleFrom="sm">
											<Text size="sm">
												{formatMoney(
													doc.total_cents,
													doc.currency,
													i18n.locale,
												)}
											</Text>
										</Table.Td>
										<Table.Td ta="right">
											<DocumentAction orgId={orgId} doc={doc} />
										</Table.Td>
									</Table.Tr>
								</Fragment>
							))}
						</Table.Tbody>
					</Table>
				</>
			)}
		</Section>
	);
}

function DocumentAction({
	orgId,
	doc,
}: {
	orgId: string;
	doc: DocumentSummaryT;
}) {
	const signable =
		doc.requires_signature &&
		(doc.status === "sent" || doc.status === "viewed");
	const pdfUrl = doc.status === "signed" ? doc.signed_pdf_url : doc.file_url;
	const href = usePdfHref(signable ? null : pdfUrl);
	const [details, setDetails] = useState(false);
	const unpaid = Boolean(
		doc.invoice &&
			doc.invoice.status !== "paid" &&
			doc.invoice.status !== "void",
	);
	if (signable) {
		return (
			<Button
				size="xs"
				variant="light"
				component={I18nLink}
				to={`/o/${orgId}/account/documents/${doc.id}/sign`}
			>
				<Trans>Sign</Trans>
			</Button>
		);
	}
	return (
		<Group gap={6} justify="flex-end" wrap="wrap">
			{unpaid && doc.invoice?.payment_url && (
				<Button
					size="xs"
					component="a"
					href={doc.invoice.payment_url}
					target="_blank"
					rel="noreferrer"
					data-testid="invoice-pay"
				>
					<Trans>Pay online</Trans>
				</Button>
			)}
			{unpaid && (
				<Button
					size="xs"
					variant="light"
					onClick={() => setDetails(true)}
					data-testid="invoice-details"
				>
					<Trans>View payment details</Trans>
				</Button>
			)}
			{unpaid && (
				<PaymentDetails
					doc={doc}
					opened={details}
					onClose={() => setDetails(false)}
				/>
			)}
			{pdfUrl && (
				<Anchor
					size="sm"
					href={href ?? undefined}
					target="_blank"
					rel="noreferrer"
					data-testid="doc-pdf"
				>
					PDF
				</Anchor>
			)}
		</Group>
	);
}

/**
 * How to pay by bank transfer: every value on its own row with a copy button, so it can
 * be pasted into a banking app without retyping.
 */
function PaymentDetails({
	doc,
	opened,
	onClose,
}: {
	doc: DocumentSummaryT;
	opened: boolean;
	onClose: () => void;
}) {
	const { i18n } = useLingui();
	const invoice = doc.invoice;
	if (!invoice) return null;
	const bt = invoice.bank_transfer;
	const rows: [string, string][] = [
		[t`Amount`, formatMoney(doc.total_cents, doc.currency, i18n.locale)],
		[t`Account name`, bt.account_name],
		["IBAN", bt.iban],
		["BIC", bt.bic],
		...(bt.reference
			? ([[t`Reference`, bt.reference]] as [string, string][])
			: []),
		...(invoice.due_on
			? ([[t`Due`, formatDate(invoice.due_on, i18n.locale)]] as [
					string,
					string,
				][])
			: []),
	];
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Payment details`}
			centered
			size="sm"
		>
			<Stack gap={10} data-testid="payment-details">
				{rows.map(([label, value]) => (
					<Group key={label} justify="space-between" wrap="nowrap" gap="xs">
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Text size="xs" c="dimmed">
								{label}
							</Text>
							<Text size="sm" style={{ overflowWrap: "anywhere" }}>
								{value}
							</Text>
						</Stack>
						<CopyButton
							value={label === "IBAN" ? value.replace(/\s/g, "") : value}
						>
							{({ copied, copy }) => (
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={copy}
									aria-label={t`Copy ${label}`}
								>
									{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
								</Button>
							)}
						</CopyButton>
					</Group>
				))}
			</Stack>
		</Modal>
	);
}
