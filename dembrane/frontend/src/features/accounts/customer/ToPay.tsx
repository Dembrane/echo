import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	Collapse,
	CopyButton,
	Group,
	SimpleGrid,
	Stack,
	Text,
} from "@mantine/core";
import { useState } from "react";
import { usePdfHref } from "../api/hooks";
import type { DocumentSummaryT } from "../contract/contract.gen";
import { documentTitle, formatDate, formatMoney } from "../format";
import { PageSection } from "./PageSection";
import { isOverdue } from "./plan";

/**
 * Invoices still to pay, before anything else on the page: the amount, when it is due,
 * and both ways to pay. Bank transfer details open in place, each value with its own
 * copy button, so they can be pasted into a banking app without retyping.
 */
export function ToPay({
	invoices,
	today,
	primary,
}: {
	invoices: DocumentSummaryT[];
	today: string;
	/** The first invoice's "Pay online" is the page's one primary action. */
	primary: boolean;
}) {
	if (invoices.length === 0) return null;
	return (
		<PageSection title={<Trans>To pay</Trans>} testId="to-pay">
			<Stack gap="md">
				{invoices.map((doc, i) => (
					<InvoiceCard
						key={doc.id}
						doc={doc}
						today={today}
						primary={primary && i === 0}
					/>
				))}
			</Stack>
		</PageSection>
	);
}

function InvoiceCard({
	doc,
	today,
	primary,
}: {
	doc: DocumentSummaryT;
	today: string;
	primary: boolean;
}) {
	const { i18n } = useLingui();
	const [open, setOpen] = useState(false);
	const href = usePdfHref(doc.file_url);
	const invoice = doc.invoice;
	if (!invoice) return null;
	const late = isOverdue(doc, today);
	const due = formatDate(invoice.due_on, i18n.locale);
	const money = (cents: number | null) =>
		formatMoney(cents, doc.currency, i18n.locale);

	return (
		<Box
			p="md"
			bg="var(--app-surface)"
			data-testid="invoice"
			data-overdue={late ? "true" : undefined}
			style={{
				borderBottom: "var(--app-stroke) solid var(--app-quiet)",
				borderTop: `var(--app-stroke) solid ${late ? "var(--app-danger)" : "var(--app-quiet)"}`,
			}}
		>
			<Stack gap="md">
				<Group
					justify="space-between"
					align="flex-start"
					gap="xs"
					wrap="nowrap"
				>
					<Stack gap="xs" style={{ minWidth: 0 }}>
						<Text>{documentTitle(doc)}</Text>
						{due && (
							<Text
								size="sm"
								c={late ? "var(--app-danger)" : "dimmed"}
								data-testid="invoice-due"
							>
								{late ? (
									<Trans>Overdue since {due}</Trans>
								) : (
									<Trans>Due {due}</Trans>
								)}
							</Text>
						)}
					</Stack>
					<Stack gap={0} align="flex-end">
						<Text fz="var(--app-font-size-lg)" lh={1.2}>
							{money(doc.total_cents)}
						</Text>
						{doc.vat_cents != null && doc.vat_cents > 0 && (
							<Text size="sm" c="dimmed">
								<Trans>incl. {money(doc.vat_cents)} VAT</Trans>
							</Text>
						)}
					</Stack>
				</Group>

				<Group gap="sm">
					{invoice.payment_url && (
						<Button
							variant={primary ? "filled" : "outline"}
							component="a"
							href={invoice.payment_url}
							target="_blank"
							rel="noreferrer"
							data-testid="invoice-pay"
						>
							<Trans>Pay online</Trans>
						</Button>
					)}
					<Button
						variant={invoice.payment_url ? "subtle" : "outline"}
						onClick={() => setOpen((o) => !o)}
						aria-expanded={open}
						data-testid="invoice-details"
					>
						{open ? (
							<Trans>Hide bank details</Trans>
						) : (
							<Trans>Pay by bank transfer</Trans>
						)}
					</Button>
					{href && (
						<Anchor
							size="sm"
							href={href}
							target="_blank"
							rel="noreferrer"
							data-testid="doc-pdf"
							ml="auto"
						>
							<Trans>Download PDF</Trans>
						</Anchor>
					)}
				</Group>

				<Collapse in={open}>
					<BankDetails doc={doc} />
				</Collapse>
			</Stack>
		</Box>
	);
}

function BankDetails({ doc }: { doc: DocumentSummaryT }) {
	const { i18n } = useLingui();
	const invoice = doc.invoice;
	if (!invoice) return null;
	const bt = invoice.bank_transfer;
	const rows: { label: string; value: string; copy?: string }[] = [
		{
			// A banking app wants the number in the viewer's own notation, without the sign.
			copy:
				doc.total_cents != null
					? new Intl.NumberFormat(i18n.locale, {
							maximumFractionDigits: 2,
							minimumFractionDigits: 2,
							useGrouping: false,
						}).format(doc.total_cents / 100)
					: "",
			label: t`Amount`,
			value: formatMoney(doc.total_cents, doc.currency, i18n.locale),
		},
		{ label: t`To`, value: bt.account_name },
		{ copy: bt.iban.replace(/\s/g, ""), label: "IBAN", value: bt.iban },
		{ label: "BIC", value: bt.bic },
		...(bt.reference ? [{ label: t`Reference`, value: bt.reference }] : []),
	];
	return (
		<Stack gap="xs" data-testid="payment-details">
			<SimpleGrid
				cols={{ base: 1, sm: 2 }}
				spacing="sm"
				verticalSpacing="xs"
				pt="sm"
				style={{ borderTop: "var(--app-stroke) solid var(--app-quiet)" }}
			>
				{rows.map(({ label, value, copy }) => (
					<Stack key={label} gap={0} style={{ minWidth: 0 }}>
						<Text size="sm" c="dimmed">
							{label}
						</Text>
						<Group gap="xs" wrap="nowrap" align="baseline">
							<Text style={{ overflowWrap: "anywhere" }}>{value}</Text>
							<CopyButton value={copy ?? value}>
								{({ copied, copy: doCopy }) => (
									<Button
										size="compact-sm"
										variant="subtle"
										onClick={doCopy}
										aria-label={t`Copy ${label}`}
									>
										{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
									</Button>
								)}
							</CopyButton>
						</Group>
					</Stack>
				))}
			</SimpleGrid>
			{bt.reference && (
				<Text size="sm" c="dimmed">
					<Trans>
						Put the reference on the transfer so we can match your payment.
					</Trans>
				</Text>
			)}
		</Stack>
	);
}
