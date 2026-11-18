import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Stack, Text, Tooltip } from "@mantine/core";
import {
	BookOpenIcon,
	DownloadSimpleIcon,
	ShareNetworkIcon,
	SignatureIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { usePdfHref } from "../api/hooks";
import type { AccountPageT, DocumentSummaryT } from "../contract/contract.gen";
import { DpaHint } from "../DpaHint";
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
 * Every document between dembrane and the organisation, as a record: on the left what it
 * is, when, how much and where it stands; on the right its tools, as icons in one line,
 * each named by its tooltip. Acting on a document happens above (To pay, To do); a
 * document still to sign opens from here too. A room member reads the offer and the DPA:
 * the book opens the document view, and the PDF is offered only where the server says it
 * may be saved (may_download). Share brings someone in, on the documents the room holds.
 */
export function DocumentsTable({
	orgId,
	documents,
	title = <Trans>Documents</Trans>,
	access = "account",
	signing = [],
	onShare,
}: {
	orgId: string;
	documents: DocumentSummaryT[];
	/** The section heading; null on the Documents page, whose own title says it. */
	title?: ReactNode;
	access?: AccountPageT["access"];
	/** The documents the person looking is named to sign, as the room says (mySigning). */
	signing?: readonly string[];
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
							signing={signing}
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
	signing,
	onShare,
}: {
	orgId: string;
	doc: DocumentSummaryT;
	access: AccountPageT["access"];
	signing: readonly string[];
	onShare?: (doc: DocumentSummaryT) => void;
}) {
	const { i18n } = useLingui();
	const waiting =
		doc.requires_signature &&
		(doc.status === "sent" || doc.status === "viewed");
	// A room member signs only what they are named to sign; everyone else reads.
	const signable =
		waiting && (access === "account" || signing.includes(doc.id));
	const reads = access === "room" && !signable && !doc.may_download;
	const pdfUrl = doc.status === "signed" ? doc.signed_pdf_url : doc.file_url;
	const href = usePdfHref(signable || !doc.may_download ? null : pdfUrl);
	const view = `/o/${orgId}/account/documents/${doc.id}/sign`;
	// Sharing brings someone into the room, and the room holds the offer and the DPA only.
	const inRoom = doc.kind === "offer" || doc.kind === "dpa";
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
						{doc.kind === "dpa" ? (
							<DpaHint>
								<span data-testid="doc-kind">
									{documentKindLabel(doc.kind)}
								</span>
							</DpaHint>
						) : (
							documentKindLabel(doc.kind)
						)}
						{[date, amount].filter(Boolean).map((part) => ` · ${part}`)}
						{" · "}
						<Text span size="sm" c={tone}>
							{status}
						</Text>
					</Text>
				</Stack>
				<Group gap="xs" wrap="nowrap" className={classes.tools}>
					{signable ? (
						<Tooltip label={t`Open to sign`}>
							<ActionIcon
								variant="subtle"
								size="lg"
								component={I18nLink}
								to={view}
								aria-label={t`Open to sign`}
								data-testid="doc-sign"
							>
								<SignatureIcon size={20} />
							</ActionIcon>
						</Tooltip>
					) : reads ? (
						<Tooltip label={t`Read`}>
							<ActionIcon
								variant="subtle"
								size="lg"
								component={I18nLink}
								to={view}
								aria-label={t`Read`}
								data-testid="doc-read"
							>
								<BookOpenIcon size={20} />
							</ActionIcon>
						</Tooltip>
					) : (
						href && (
							<Tooltip label={t`Download PDF`}>
								<ActionIcon
									variant="subtle"
									size="lg"
									component="a"
									href={href}
									target="_blank"
									rel="noreferrer"
									aria-label={t`Download PDF`}
									data-testid="doc-pdf"
								>
									<DownloadSimpleIcon size={20} />
								</ActionIcon>
							</Tooltip>
						)
					)}
					{onShare && inRoom && (
						<Tooltip label={t`Share with a colleague`}>
							<ActionIcon
								variant="subtle"
								size="lg"
								onClick={() => onShare(doc)}
								aria-label={t`Share with a colleague`}
								data-testid="doc-share"
							>
								<ShareNetworkIcon size={20} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>
		</Row>
	);
}
