import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	Group,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import type { AccountPageT } from "../contract/contract.gen";
import { PageSection } from "./PageSection";

type Billing = AccountPageT["billing"];
/** The typed fields; the Peppol match and the delivery choice are not text. */
type Key = Exclude<keyof Billing, "peppol_match" | "invoice_delivery">;

const toForm = (b: Billing): Record<Key, string> =>
	Object.fromEntries(
		Object.entries(b)
			.filter(([k]) => k !== "peppol_match" && k !== "invoice_delivery")
			.map(([k, v]) => [k, v ?? ""]),
	) as Record<Key, string>;

/** What an invoice cannot do without. */
const REQUIRED: Key[] = [
	"legal_name",
	"billing_email",
	"address_line1",
	"postal_code",
	"city",
	"country",
];
/** A registration number: any one of them is enough. */
const NUMBERS: Key[] = ["vat_id", "kvk_number", "kbo_number"];

/**
 * The details Exact needs to invoice: who, where, a registration number (VAT, KvK or KBO,
 * at least one), and what the customer's finance team wants on the invoice. Written for
 * someone who does not do this often: every problem shows at once, next to its field, and
 * the page says when the details are in.
 */
export function BillingForm({
	orgId,
	billing,
	pending = false,
}: {
	orgId: string;
	billing: Billing;
	/** The billing details step still waits: saving what is already there completes it. */
	pending?: boolean;
}) {
	const [form, setForm] = useState(() => toForm(billing));
	const [missing, setMissing] = useState<Key[]>([]);
	useEffect(() => setForm(toForm(billing)), [billing]);
	const mutation = useAccountsMutation("updateBilling", { orgId });
	const serverFields =
		mutation.error instanceof AccountsApiError ? mutation.error.fields : {};
	const numberMissing = NUMBERS.every((k) => missing.includes(k));
	const errorOf = (key: Key) =>
		serverFields[key] ??
		(REQUIRED.includes(key) && missing.includes(key)
			? t`Fill this in.`
			: undefined);
	const saved = toForm(billing);
	const dirty = Object.entries(saved).some(([k, v]) => form[k as Key] !== v);
	const complete =
		REQUIRED.every((k) => saved[k].trim()) &&
		NUMBERS.some((k) => saved[k].trim());
	// Complete details read as what goes on the invoice; the form opens on "Edit".
	const [editing, setEditing] = useState(() => pending || !complete);

	const input = (
		key: Key,
		label: string,
		props: Partial<React.ComponentProps<typeof TextInput>> = {},
	) => (
		<TextInput
			label={label}
			value={form[key]}
			onChange={(e) => {
				const value = e.currentTarget.value;
				setForm((f) => ({ ...f, [key]: value }));
				setMissing((m) =>
					NUMBERS.includes(key)
						? m.filter((k) => !NUMBERS.includes(k))
						: m.filter((k) => k !== key),
				);
			}}
			error={errorOf(key)}
			data-testid={`billing-${key}`}
			{...props}
		/>
	);

	const save = () => {
		// Every gap at once, so nobody fixes one field to be told about the next.
		const gaps = REQUIRED.filter((k) => !form[k].trim());
		if (NUMBERS.every((k) => !form[k].trim())) gaps.push(...NUMBERS);
		setMissing(gaps);
		if (gaps.length) return;
		mutation.mutate(
			{ body: form },
			{
				onSuccess: () => {
					toast.success(t`Billing details saved`);
					setEditing(false);
				},
			},
		);
	};

	if (!editing) {
		return (
			<PageSection
				title={<Trans>Billing details</Trans>}
				testId="billing"
				action={
					<Anchor
						component="button"
						size="sm"
						onClick={() => setEditing(true)}
						data-testid="billing-edit"
					>
						<Trans>Edit</Trans>
					</Anchor>
				}
			>
				<BillingSummary billing={saved} />
			</PageSection>
		);
	}

	return (
		<PageSection title={<Trans>Billing details</Trans>} testId="billing">
			<Box maw={640}>
				<Stack gap="md">
					<Text c="dimmed">
						<Trans>What we put on your invoices.</Trans>
					</Text>
					<SimpleGrid
						cols={{ base: 1, sm: 2 }}
						spacing="sm"
						verticalSpacing="sm"
					>
						{input("legal_name", t`Legal name of your organisation`, {
							autoComplete: "organization",
							required: true,
						})}
						{input("billing_email", t`Invoice email`, {
							autoComplete: "email",
							inputMode: "email",
							required: true,
							type: "email",
						})}
						{input("address_line1", t`Address`, {
							autoComplete: "address-line1",
							required: true,
						})}
						{input("address_line2", t`Address line 2`, {
							autoComplete: "address-line2",
						})}
						{input("postal_code", t`Postal code`, {
							autoComplete: "postal-code",
							required: true,
						})}
						{input("city", t`City`, {
							autoComplete: "address-level2",
							required: true,
						})}
						{input("country", t`Country`, {
							autoComplete: "country-name",
							required: true,
						})}
					</SimpleGrid>
					<Stack
						gap="xs"
						role="group"
						aria-labelledby="billing-numbers"
						data-testid="billing-numbers"
					>
						<Text
							id="billing-numbers"
							size="sm"
							c={numberMissing ? "var(--app-danger)" : undefined}
						>
							<Trans>Registration number: fill in at least one</Trans>
						</Text>
						<SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
							{input("vat_id", t`VAT number`, {
								error: serverFields.vat_id ?? numberMissing,
							})}
							{input("kvk_number", t`KvK number (Netherlands)`, {
								error: numberMissing,
							})}
							{input("kbo_number", t`KBO number (Belgium)`, {
								error: numberMissing,
							})}
						</SimpleGrid>
					</Stack>
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
						{input("po_number", t`PO number`, {
							description: t`If your finance team uses one`,
						})}
						{input("peppol_id", t`Peppol ID`, {
							description: t`Only if you get invoices through Peppol`,
						})}
					</SimpleGrid>
					<Group gap="sm">
						<Button
							onClick={save}
							loading={mutation.isPending}
							variant="filled"
							disabled={!dirty && !pending}
							data-testid="billing-save"
						>
							<Trans>Save billing details</Trans>
						</Button>
						{!pending && complete && (
							<Button
								variant="subtle"
								onClick={() => {
									setForm(saved);
									setMissing([]);
									setEditing(false);
								}}
								data-testid="billing-cancel"
							>
								<Trans>Cancel</Trans>
							</Button>
						)}
						{mutation.error &&
							!(
								mutation.error instanceof AccountsApiError &&
								Object.keys(serverFields).length
							) && <ErrorNotice error={mutation.error} />}
					</Group>
				</Stack>
			</Box>
		</PageSection>
	);
}

/** The saved details as they will read on an invoice. */
function BillingSummary({ billing }: { billing: Record<Key, string> }) {
	const address = [
		billing.address_line1,
		billing.address_line2,
		[billing.postal_code, billing.city].filter(Boolean).join(" "),
		billing.country,
	].filter((line) => line.trim());
	const rows: [string, string[]][] = [
		[t`Organisation`, [billing.legal_name]],
		[t`Address`, address],
		[t`Invoices go to`, [billing.billing_email]],
		[t`VAT number`, [billing.vat_id]],
		[t`KvK number`, [billing.kvk_number]],
		[t`KBO number`, [billing.kbo_number]],
		[t`PO number`, [billing.po_number]],
		[t`Peppol ID`, [billing.peppol_id]],
	];
	return (
		<SimpleGrid
			cols={{ base: 1, sm: 2 }}
			spacing="lg"
			verticalSpacing="sm"
			maw={640}
			data-testid="billing-summary"
		>
			{rows
				.filter(([, lines]) => lines.some((line) => line.trim()))
				.map(([label, lines]) => (
					<Stack key={label} gap={0}>
						<Text size="sm" c="dimmed">
							{label}
						</Text>
						{lines.map((line) => (
							<Text key={line} style={{ overflowWrap: "anywhere" }}>
								{line}
							</Text>
						))}
					</Stack>
				))}
		</SimpleGrid>
	);
}
