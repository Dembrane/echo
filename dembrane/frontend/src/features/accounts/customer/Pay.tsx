import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	CopyButton,
	Group,
	Modal,
	SimpleGrid,
	Stack,
	Text,
} from "@mantine/core";
import { usePdfHref } from "../api/hooks";
import type { DocumentSummaryT } from "../contract/contract.gen";
import { formatDate, formatMoney } from "../format";
import { isOverdue } from "./plan";
import { Figure, KindIcon, TaskLine } from "./TaskLine";

/**
 * An invoice still to pay, as a task line in To do: what to pay and by when, the amount
 * at the right, and one pill that says it. Paying opens the pay step, which has paying
 * online and the bank transfer details side by side.
 */
export function PayLine({
	doc,
	today,
	onPay,
}: {
	doc: DocumentSummaryT;
	today: string;
	onPay: () => void;
}) {
	const { i18n } = useLingui();
	const invoice = doc.invoice;
	if (!invoice) return null;
	const late = isOverdue(doc, today);
	const due = formatDate(invoice.due_on, i18n.locale);
	const amount = formatMoney(doc.total_cents, doc.currency, i18n.locale);
	const vat = formatMoney(doc.vat_cents, doc.currency, i18n.locale);
	const days = invoice.due_on ? daysBetween(invoice.due_on, today) : 0;
	return (
		<TaskLine
			testId="invoice"
			data-overdue={late ? "true" : undefined}
			marker={<KindIcon kind="pay" />}
			title={payTitle(doc)}
			fact={
				late ? (
					<>
						<Text span inherit c="var(--app-danger)" data-testid="invoice-due">
							{days > 0 ? (
								<Plural
									value={days}
									one="# day overdue"
									other="# days overdue"
								/>
							) : (
								<Trans>Overdue</Trans>
							)}
						</Text>
						{due && (
							<>
								{" · "}
								<Trans>was due {due}</Trans>
							</>
						)}
					</>
				) : due ? (
					<span data-testid="invoice-due">
						<Trans>Due {due}</Trans>
					</span>
				) : null
			}
			figure={
				<Figure
					amount={amount}
					vat={
						doc.vat_cents != null && doc.vat_cents > 0 ? (
							<Trans>incl. {vat} VAT</Trans>
						) : undefined
					}
				/>
			}
			actions={
				<Button variant="filled" onClick={onPay} data-testid="invoice-pay">
					<Trans>Pay {amount}</Trans>
				</Button>
			}
		/>
	);
}

/** "Pay invoice 2026-0421": the act and the number people forward. */
const payTitle = (doc: DocumentSummaryT) => {
	const number = doc.invoice?.number;
	const title = doc.title;
	return number ? t`Pay invoice ${number}` : t`Pay ${title}`;
};

/** Whole days from one YYYY-MM-DD to the next. */
const daysBetween = (from: string, to: string) =>
	Math.round(
		(Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5,
	);

/**
 * The pay step: the amount, paying online when there is a checkout, and the bank transfer
 * details, each value with its own copy button so it can be pasted into a banking app.
 */
export function PayModal({
	doc,
	onClose,
}: {
	doc: DocumentSummaryT | null;
	onClose: () => void;
}) {
	const { i18n } = useLingui();
	const href = usePdfHref(doc?.file_url);
	const invoice = doc?.invoice;
	const money = (cents: number | null | undefined) =>
		formatMoney(cents, doc?.currency, i18n.locale);
	return (
		<Modal
			opened={doc !== null}
			onClose={onClose}
			title={doc ? payTitle(doc) : null}
			centered
			size="lg"
		>
			{doc && invoice && (
				<Stack gap="lg" data-testid="pay-step">
					<Stack gap={0}>
						<Text size="lg" lh={1.3}>
							{money(doc.total_cents)}
						</Text>
						{doc.vat_cents != null && doc.vat_cents > 0 && (
							<Text size="xs" c="dimmed">
								<Trans>incl. {money(doc.vat_cents)} VAT</Trans>
							</Text>
						)}
					</Stack>
					<SimpleGrid
						cols={{ base: 1, sm: invoice.payment_url ? 2 : 1 }}
						spacing="xl"
					>
						{invoice.payment_url && (
							<Stack gap="sm" align="flex-start">
								<Text>
									<Trans>Online</Trans>
								</Text>
								<Button
									variant="filled"
									component="a"
									href={invoice.payment_url}
									target="_blank"
									rel="noreferrer"
									data-testid="pay-online"
								>
									<Trans>Pay online</Trans>
								</Button>
							</Stack>
						)}
						<Stack gap="sm">
							<Text>
								<Trans>By bank transfer</Trans>
							</Text>
							<BankDetails doc={doc} />
						</Stack>
					</SimpleGrid>
					{href && (
						<Anchor
							size="sm"
							href={href}
							target="_blank"
							rel="noreferrer"
							data-testid="doc-pdf"
						>
							<Trans>Download the invoice as PDF</Trans>
						</Anchor>
					)}
				</Stack>
			)}
		</Modal>
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
			<SimpleGrid cols={1} spacing="sm" verticalSpacing="xs">
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
