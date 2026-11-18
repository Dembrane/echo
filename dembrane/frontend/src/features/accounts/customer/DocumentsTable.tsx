import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { usePdfHref } from "../api/hooks";
import type { AccountPageT, DocumentSummaryT } from "../contract/contract.gen";
import {
	documentKindLabel,
	documentStatusLabel,
	documentTitle,
	formatDate,
	formatMoney,
} from "../format";
import classes from "./DocumentsTable.module.css";
import { PageSection, Row, Rows } from "./PageSection";

/**
 * Every document between dembrane and the organisation, as a record: what it is, when,
 * how much, and where it stands, with the PDF one click away. Acting on a document
 * happens above (To pay, To do); a document still to sign links there too. A room member
 * reads the offer and the DPA: "Read" opens the document view, and the PDF is offered
 * only where the server says it may be saved (may_download). Share brings someone in,
 * for that document.
 */
export function DocumentsTable({
	orgId,
	documents,
	title = <Trans>Documents</Trans>,
	access = "account",
	myEmail,
	onShare,
}: {
	orgId: string;
	documents: DocumentSummaryT[];
	/** The section heading; null on the Documents page, whose own title says it. */
	title?: ReactNode;
	access?: AccountPageT["access"];
	/** The person looking: a room member named to sign opens their document to sign. */
	myEmail?: string;
	/** Brings someone in, for this document; absent where nobody can add someone. */
	onShare?: (doc: DocumentSummaryT) => void;
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
						<DocumentRow
							key={doc.id}
							orgId={orgId}
							doc={doc}
							access={access}
							myEmail={myEmail}
							onShare={onShare}
						/>
					))}
				</Rows>
			)}
		</PageSection>
	);
}

function DocumentRow({
	orgId,
	doc,
	access,
	myEmail,
	onShare,
}: {
	orgId: string;
	doc: DocumentSummaryT;
	access: AccountPageT["access"];
	myEmail?: string;
	onShare?: (doc: DocumentSummaryT) => void;
}) {
	const { i18n } = useLingui();
	const waiting =
		doc.requires_signature &&
		(doc.status === "sent" || doc.status === "viewed");
	// A room member signs only what they are named to sign; everyone else reads.
	const named =
		myEmail !== undefined &&
		doc.signer?.email.toLowerCase() === myEmail.toLowerCase();
	const signable = waiting && (access === "account" || named);
	const reads = access === "room" && !signable && !doc.may_download;
	const pdfUrl = doc.status === "signed" ? doc.signed_pdf_url : doc.file_url;
	const href = usePdfHref(signable || !doc.may_download ? null : pdfUrl);
	const view = `/o/${orgId}/account/documents/${doc.id}/sign`;
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
				<Stack gap="xs" className={classes.what}>
					<Text className={classes.title}>{documentTitle(doc)}</Text>
					<Text size="sm" c="dimmed">
						{[documentKindLabel(doc.kind), date].filter(Boolean).join(" · ")}
						{" · "}
						<Text span size="sm" c={tone}>
							{status}
						</Text>
					</Text>
				</Stack>
				<Stack gap="xs" align="flex-end" className={classes.actions}>
					{amount && <Text>{amount}</Text>}
					{signable ? (
						<Anchor
							size="sm"
							component={I18nLink}
							to={view}
							data-testid="doc-sign"
						>
							<Trans>Open to sign</Trans>
						</Anchor>
					) : reads ? (
						<Anchor
							size="sm"
							component={I18nLink}
							to={view}
							data-testid="doc-read"
						>
							<Trans>Read</Trans>
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
					{onShare && (
						<Anchor
							component="button"
							size="sm"
							onClick={() => onShare(doc)}
							data-testid="doc-share"
							className={classes.share}
						>
							<ShareNetworkIcon size={16} aria-hidden />
							<Trans>Share with a colleague</Trans>
						</Anchor>
					)}
				</Stack>
			</Group>
		</Row>
	);
}
