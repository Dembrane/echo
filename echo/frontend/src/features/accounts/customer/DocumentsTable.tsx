import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Button,
	CopyButton,
	Group,
	Table,
	Text,
} from "@mantine/core";
import { Fragment } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { usePdfHref } from "../api/hooks";
import type { DocumentSummaryT } from "../contract/contract.gen";
import {
	documentKindLabel,
	documentStatusColor,
	documentStatusLabel,
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
				<Table verticalSpacing="xs" horizontalSpacing="xs" layout="fixed">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Document</Trans>
							</Table.Th>
							<Table.Th w={110}>
								<Trans>Status</Trans>
							</Table.Th>
							<Table.Th w={120} ta="right" visibleFrom="sm">
								<Trans>Amount</Trans>
							</Table.Th>
							<Table.Th w={{ base: 92, sm: 150 }} />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{documents.map((doc) => (
							<Fragment key={doc.id}>
								<Table.Tr data-testid={`doc-${doc.kind}`}>
									<Table.Td>
										<Text size="sm" truncate>
											{doc.title}
										</Text>
										<Text size="xs" c="dimmed" truncate>
											{documentKindLabel(doc.kind)} ·{" "}
											{formatDate(
												doc.signed_at ?? doc.invoice?.issued_on ?? doc.sent_at,
												i18n.locale,
											)}
											<Text span hiddenFrom="sm">
												{doc.total_cents != null &&
													` · ${formatMoney(doc.total_cents, doc.currency, i18n.locale)}`}
											</Text>
										</Text>
									</Table.Td>
									<Table.Td>
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
											{formatMoney(doc.total_cents, doc.currency, i18n.locale)}
										</Text>
									</Table.Td>
									<Table.Td ta="right">
										<DocumentAction orgId={orgId} doc={doc} />
									</Table.Td>
								</Table.Tr>
								{doc.invoice &&
									doc.invoice.status !== "paid" &&
									doc.invoice.status !== "void" && (
										<Table.Tr>
											<Table.Td colSpan={4} pt={0}>
												<BankTransfer doc={doc} />
											</Table.Td>
										</Table.Tr>
									)}
							</Fragment>
						))}
					</Table.Tbody>
				</Table>
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
	if (signable) {
		return (
			<Button
				size="xs"
				component={I18nLink}
				to={`/o/${orgId}/account/documents/${doc.id}/sign`}
			>
				<Trans>Sign</Trans>
			</Button>
		);
	}
	return (
		<Group gap={6} justify="flex-end" wrap="nowrap">
			{doc.invoice?.payment_url && doc.invoice.status !== "paid" && (
				<Button
					size="xs"
					component="a"
					href={doc.invoice.payment_url}
					target="_blank"
					rel="noreferrer"
					data-testid="invoice-pay"
				>
					<Trans>Pay</Trans>
				</Button>
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

function BankTransfer({ doc }: { doc: DocumentSummaryT }) {
	const { i18n } = useLingui();
	const invoice = doc.invoice;
	if (!invoice) return null;
	const bt = invoice.bank_transfer;
	const amount = formatMoney(doc.total_cents, doc.currency, i18n.locale);
	const due = formatDate(invoice.due_on, i18n.locale);
	return (
		<Group gap={6} wrap="wrap" data-testid="bank-transfer">
			<Text size="xs" c="dimmed">
				<Trans>
					Transfer {amount} to {bt.account_name}, IBAN {bt.iban}, BIC {bt.bic}
				</Trans>
				{bt.reference && (
					<>
						{", "}
						<Trans>reference {bt.reference}</Trans>
					</>
				)}
				{due && (
					<>
						{", "}
						<Trans>by {due}</Trans>
					</>
				)}
				.
			</Text>
			<CopyButton value={bt.iban.replace(/\s/g, "")}>
				{({ copied, copy }) => (
					<Anchor component="button" size="xs" onClick={copy}>
						{copied ? <Trans>Copied</Trans> : <Trans>Copy IBAN</Trans>}
					</Anchor>
				)}
			</CopyButton>
		</Group>
	);
}
