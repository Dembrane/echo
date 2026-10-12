import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { usePdfHref } from "../api/hooks";
import type { DocumentSummaryT } from "../contract/contract.gen";
import {
	documentKindLabel,
	documentStatusLabel,
	documentTitle,
	formatDate,
	formatMoney,
} from "../format";
import { PageSection, Row, Rows } from "./PageSection";

/**
 * Every document between dembrane and the organisation, as a record: what it is, when,
 * how much, and where it stands, with the PDF one click away. Acting on a document
 * happens above (To pay, To do); a document still to sign links there too.
 */
export function DocumentsTable({
	orgId,
	documents,
	title = <Trans>Documents</Trans>,
}: {
	orgId: string;
	documents: DocumentSummaryT[];
	/** The section heading; null on the Documents page, whose own title says it. */
	title?: ReactNode;
}) {
	return (
		<PageSection title={title} testId="documents">
			{documents.length === 0 ? (
				<Text c="dimmed">
					<Trans>
						Offers, agreements and invoices appear here once we send them.
					</Trans>
				</Text>
			) : (
				<Rows>
					{documents.map((doc) => (
						<DocumentRow key={doc.id} orgId={orgId} doc={doc} />
					))}
				</Rows>
			)}
		</PageSection>
	);
}

function DocumentRow({ orgId, doc }: { orgId: string; doc: DocumentSummaryT }) {
	const { i18n } = useLingui();
	const signable =
		doc.requires_signature &&
		(doc.status === "sent" || doc.status === "viewed");
	const pdfUrl = doc.status === "signed" ? doc.signed_pdf_url : doc.file_url;
	const href = usePdfHref(signable ? null : pdfUrl);
	const date = formatDate(
		doc.signed_at ??
			doc.invoice?.paid_at ??
			doc.invoice?.issued_on ??
			doc.sent_at,
		i18n.locale,
	);
	const amount = formatMoney(doc.total_cents, doc.currency, i18n.locale);
	const status = documentStatusLabel(doc);
	const tone =
		doc.invoice?.status === "overdue"
			? "var(--app-danger)"
			: doc.status === "signed" || doc.invoice?.status === "paid"
				? "var(--app-success)"
				: "dimmed";

	return (
		<Row testId={`doc-${doc.kind}`}>
			<Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
				<Stack gap="xs" style={{ minWidth: 0 }}>
					<Text style={{ overflowWrap: "anywhere" }}>{documentTitle(doc)}</Text>
					<Text size="sm" c="dimmed">
						{[documentKindLabel(doc.kind), date].filter(Boolean).join(" · ")}
						{" · "}
						<Text span size="sm" c={tone}>
							{status}
						</Text>
					</Text>
				</Stack>
				<Stack gap="xs" align="flex-end" style={{ flexShrink: 0 }}>
					{amount && <Text>{amount}</Text>}
					{signable ? (
						<Anchor
							size="sm"
							component={I18nLink}
							to={`/o/${orgId}/account/documents/${doc.id}/sign`}
							data-testid="doc-sign"
						>
							<Trans>Open to sign</Trans>
						</Anchor>
					) : (
						href && (
							<Anchor
								size="sm"
								href={href}
								target="_blank"
								rel="noreferrer"
								data-testid="doc-pdf"
							>
								<Trans>Download PDF</Trans>
							</Anchor>
						)
					)}
				</Stack>
			</Group>
		</Row>
	);
}
