import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	Checkbox,
	type ComboboxItem,
	Group,
	type OptionsFilter,
	Radio,
	Select,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import {
	type BillingField,
	COUNTRY_CODES,
	checkBilling,
	cleanKbo,
	cleanKvk,
	cleanVat,
	countryCodeOf,
	countryGroup,
	countryName,
	EU_VAT,
	identified,
	kvkFits,
	saysNoVat,
} from "../contract/billing-rules.gen";
import type { AccountPageT } from "../contract/contract.gen";
import {
	type Delivery,
	deliveryFor,
	InvoiceDelivery,
	type SentDelivery,
	usePeppolLookup,
} from "./InvoiceDelivery";
import { PageSection } from "./PageSection";

type Billing = AccountPageT["billing"];
/** The fields typed into the form; the country, the choices and the Peppol match are not text. */
const FIELDS = [
	"legal_name",
	"billing_email",
	"address_line1",
	"address_line2",
	"postal_code",
	"city",
	"vat_id",
	"kvk_number",
	"kbo_number",
	"po_number",
	"peppol_id",
	"invoice_portal",
] as const;
type Key = (typeof FIELDS)[number];
/** Every place a problem can show: a typed field, or the country. */
type Place = Key | BillingField;
type Problems = Partial<Record<Place, "missing" | "format">>;

const toForm = (b: Billing): Record<Key, string> =>
	Object.fromEntries(FIELDS.map((k) => [k, b[k] ?? ""])) as Record<Key, string>;
/** Details from before the form had a list carry the country as text. */
const countryOf = (b: Billing) => b.country_code ?? countryCodeOf(b.country);
/** Details from before the question was asked say it by a KvK or KBO number given alone. */
const noVatOf = (b: Billing) => saysNoVat({ ...b, country_code: countryOf(b) });

/** What an invoice cannot do without, whatever the country. */
const REQUIRED: Key[] = [
	"legal_name",
	"billing_email",
	"address_line1",
	"postal_code",
	"city",
];
/** Names that start with what was typed come first: "Nether" offers the Netherlands before the Caribbean Netherlands. */
const startsFirst: OptionsFilter = ({ options, search }) => {
	const typed = search.trim().toLocaleLowerCase();
	const name = (o: ComboboxItem) => o.label.toLocaleLowerCase();
	const hits = (options as ComboboxItem[]).filter((o) =>
		name(o).includes(typed),
	);
	return [
		...hits.filter((o) => name(o).startsWith(typed)),
		...hits.filter((o) => !name(o).startsWith(typed)),
	];
};
const KBO_EXAMPLE = "0123.456.789";
const PEPPOL_EXAMPLE = "0106:12345678";

/**
 * The details Exact needs to invoice. The country comes first, because it decides which
 * numbers we ask for (the rules are the API's own, billing-rules.gen.ts): in the EU a VAT
 * number or "we have none" (the Netherlands then gives its KvK number, Belgium its KBO
 * number), nothing more outside it. Then who and where, and how invoices should arrive:
 * by email, through Peppol, or another way, which the customer writes to us as a question.
 * The form decides no tax and gives no tax advice. Written for someone who does not do
 * this often: every problem shows at once, next to its field, and the page says when the
 * details are in.
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
	const { i18n } = useLingui();
	const [form, setForm] = useState(() => toForm(billing));
	const [country, setCountry] = useState(() => countryOf(billing));
	const [noVat, setNoVat] = useState(() => noVatOf(billing));
	const [chosen, setChosen] = useState(billing.invoice_delivery);
	const [problems, setProblems] = useState<Problems>({});
	useEffect(() => {
		setForm(toForm(billing));
		setCountry(countryOf(billing));
		setNoVat(noVatOf(billing));
		setChosen(billing.invoice_delivery);
	}, [billing]);

	const group = countryGroup(country);
	// Every EU country is asked for a VAT number, or the plain answer that there is none.
	const asksNoVat = group !== null && group !== "other";
	const said = asksNoVat && noVat;
	// A Dutch organisation that gives its VAT number is not asked for its KvK number. One
	// we already hold stays, because the Peppol lookup tries it first.
	const heldKvk =
		country === countryOf(billing) ? cleanKvk(billing.kvk_number) : "";
	// Only what the country asks for is sent; a number typed for another country is dropped.
	const numbers = {
		kbo_number: group === "be" && said ? cleanKbo(form.kbo_number) : "",
		kvk_number:
			group !== "nl"
				? ""
				: said
					? cleanKvk(form.kvk_number)
					: kvkFits(heldKvk)
						? heldKvk
						: "",
		vat_id: said ? "" : cleanVat(country, form.vat_id),
	};
	const lookup = usePeppolLookup(orgId, numbers);
	const typedPeppol = form.peppol_id.trim();
	const delivery: Delivery =
		chosen ?? (lookup.match || typedPeppol ? "peppol" : "email");

	const countries = useMemo(() => {
		const collator = new Intl.Collator(i18n.locale);
		return COUNTRY_CODES.map((code) => ({
			label: countryName(code, i18n.locale),
			value: code,
		})).sort((a, b) => collator.compare(a.label, b.label));
	}, [i18n.locale]);

	const mutation = useAccountsMutation("updateBilling", { orgId });
	const serverFields =
		mutation.error instanceof AccountsApiError ? mutation.error.fields : {};
	const vatExample = country ? EU_VAT[country]?.example : undefined;
	const examples: Partial<Record<Place, string>> = {
		kbo_number: KBO_EXAMPLE,
		peppol_id: PEPPOL_EXAMPLE,
		vat_id: vatExample,
	};
	const forExample = (example: string) => t`For example ${example}`;
	const errorOf = (key: Place) => {
		if (serverFields[key]) return serverFields[key];
		if (problems[key] === "missing")
			return key === "country_code" ? t`Choose one.` : t`Fill this in.`;
		if (problems[key] !== "format") return undefined;
		if (key === "kvk_number") return t`A KvK number has 8 digits.`;
		const example = examples[key];
		return example
			? t`Check this. It should look like ${example}.`
			: t`Fill this in.`;
	};
	const clear = (...keys: Place[]) =>
		setProblems((p) =>
			Object.fromEntries(
				Object.entries(p).filter(([k]) => !keys.includes(k as Place)),
			),
		);

	const saved = toForm(billing);
	const savedCountry = countryOf(billing);
	const dirty =
		Object.entries(saved).some(([k, v]) => form[k as Key] !== v) ||
		country !== savedCountry ||
		noVat !== noVatOf(billing) ||
		(chosen ?? null) !== (billing.invoice_delivery ?? null);
	const savedDelivery = deliveryFor(
		billing.peppol_match,
		billing.invoice_delivery,
	);
	// Opting out of Peppol from the summary saves at once: the details are complete.
	const switchDelivery = (next: SentDelivery) =>
		mutation.mutate(
			{
				body: {
					...saved,
					country_code: savedCountry,
					invoice_delivery: next,
					no_vat_number: billing.no_vat_number,
				},
			},
			{
				// Details from before the numbers were checked may not pass: the form shows where.
				onError: () => setEditing(true),
				onSuccess: () =>
					toast.success(
						next === "email"
							? t`Invoices will come by email`
							: t`Invoices will come via Peppol`,
					),
			},
		);
	const complete =
		REQUIRED.every((k) => saved[k].trim()) &&
		Boolean(billing.country?.trim()) &&
		identified(billing);
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
				clear(key);
			}}
			error={errorOf(key)}
			data-testid={`billing-${key}`}
			{...props}
		/>
	);

	const save = () => {
		const answers = {
			...numbers,
			country_code: country,
			invoice_delivery: delivery,
			// Another way: what they write here reaches dembrane as their question.
			invoice_portal: delivery === "other" ? form.invoice_portal.trim() : "",
			no_vat_number: asksNoVat ? noVat : null,
			// Found in the directory, the Peppol ID is known; else it is the one typed.
			peppol_id: delivery === "peppol" && !lookup.match ? typedPeppol : "",
		};
		// Every gap at once, so nobody fixes one field to be told about the next.
		const gaps: Problems = {};
		for (const k of REQUIRED) if (!form[k].trim()) gaps[k] = "missing";
		for (const p of checkBilling(answers).problems) gaps[p.field] ??= p.kind;
		if (delivery === "peppol" && !lookup.match && !typedPeppol)
			gaps.peppol_id = "missing";
		setProblems(gaps);
		if (Object.keys(gaps).length) return;
		mutation.mutate(
			{
				body: {
					address_line1: form.address_line1,
					address_line2: form.address_line2,
					billing_email: form.billing_email,
					city: form.city,
					legal_name: form.legal_name,
					po_number: form.po_number,
					postal_code: form.postal_code,
					...answers,
				},
			},
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
				<Stack gap="md" maw={640}>
					<InvoiceDelivery
						match={billing.peppol_match}
						delivery={savedDelivery}
						email={billing.billing_email}
						onChange={switchDelivery}
						disabled={mutation.isPending}
					/>
					<BillingSummary
						billing={saved}
						country={
							savedCountry
								? countryName(savedCountry, i18n.locale)
								: (billing.country ?? "")
						}
						noVat={billing.no_vat_number === true}
					/>
				</Stack>
			</PageSection>
		);
	}

	const id = lookup.match?.participant_id;
	const vatHint = vatExample ? forExample(vatExample) : undefined;

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
						<Select
							label={t`Country`}
							placeholder={t`Choose a country`}
							data={countries}
							value={country}
							onChange={(code) => {
								if (code === country) return;
								// The numbers belong to the country: another country starts them over.
								setCountry(code);
								setNoVat(false);
								setForm((f) => ({
									...f,
									kbo_number: "",
									kvk_number: "",
									vat_id: "",
								}));
								clear("country_code", "vat_id", "kvk_number", "kbo_number");
							}}
							searchable
							filter={startsFirst}
							allowDeselect={false}
							nothingFoundMessage={t`No country found`}
							required
							error={errorOf("country_code")}
							data-testid="billing-country"
						/>
					</SimpleGrid>
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
					</SimpleGrid>
					{asksNoVat && (
						// Top to bottom: the number, the way to say there is none, then the number the country gives instead.
						<Stack gap="xs" data-testid="billing-numbers">
							<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
								{input("vat_id", t`VAT number`, {
									description: vatHint,
									disabled: noVat,
									required: !noVat,
									value: noVat ? "" : form.vat_id,
								})}
							</SimpleGrid>
							<Checkbox
								label={t`We have no VAT number`}
								checked={noVat}
								onChange={(e) => {
									setNoVat(e.currentTarget.checked);
									clear("vat_id", "kvk_number", "kbo_number", "no_vat_number");
								}}
								data-testid="billing-no-vat"
							/>
							{group === "nl" && noVat && (
								<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
									{input("kvk_number", t`KvK number`, {
										description: t`8 digits`,
										inputMode: "numeric",
										required: true,
									})}
								</SimpleGrid>
							)}
							{group === "be" && noVat && (
								<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
									{input("kbo_number", t`KBO number`, {
										description: forExample(KBO_EXAMPLE),
										required: true,
									})}
								</SimpleGrid>
							)}
						</Stack>
					)}
					{group === "other" && (
						<SimpleGrid
							cols={{ base: 1, sm: 2 }}
							spacing="sm"
							data-testid="billing-numbers"
						>
							{input("vat_id", t`VAT or tax number`, {
								description: t`If you have one`,
							})}
						</SimpleGrid>
					)}
					<Radio.Group
						label={t`How do you want to get invoices?`}
						value={delivery}
						onChange={(next) => {
							setChosen(next as Delivery);
							clear("peppol_id", "invoice_portal");
						}}
						data-testid="billing-delivery"
					>
						<Stack gap="xs" mt="xs">
							<Radio
								value="email"
								label={t`By email`}
								description={t`To your invoice email`}
								data-testid="delivery-email"
							/>
							<Radio
								value="peppol"
								label={t`Through Peppol`}
								description={t`Invoices arrive in your accounting software`}
								data-testid="delivery-peppol"
							/>
							<Radio
								value="other"
								label={t`Another way`}
								description={t`For example an invoice portal`}
								data-testid="delivery-other"
							/>
						</Stack>
					</Radio.Group>
					{delivery === "peppol" &&
						(id ? (
							<Text size="sm" data-testid="peppol-found">
								<Trans>We found you in the Peppol directory ({id}).</Trans>
							</Text>
						) : lookup.checking ? (
							<Text size="sm" c="dimmed" data-testid="peppol-checking">
								<Trans>Checking the Peppol directory…</Trans>
							</Text>
						) : (
							<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
								{input("peppol_id", t`Peppol ID`, {
									description: forExample(PEPPOL_EXAMPLE),
									required: true,
								})}
							</SimpleGrid>
						))}
					{delivery === "other" && (
						// The same question a customer can ask under "Talk to us": saving sends it.
						<Textarea
							label={t`Tell us how your organisation receives invoices`}
							description={t`We will set it up with you.`}
							value={form.invoice_portal}
							onChange={(e) => {
								const value = e.currentTarget.value;
								setForm((f) => ({ ...f, invoice_portal: value }));
								clear("invoice_portal");
							}}
							error={errorOf("invoice_portal")}
							autosize
							minRows={3}
							maxLength={2000}
							required
							data-testid="billing-invoice_portal"
						/>
					)}
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
						{input("po_number", t`PO number`, {
							description: t`If your finance team uses one`,
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
									setCountry(savedCountry);
									setNoVat(noVatOf(billing));
									setChosen(billing.invoice_delivery);
									setProblems({});
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
function BillingSummary({
	billing,
	country,
	noVat,
}: {
	billing: Record<Key, string>;
	country: string;
	noVat: boolean;
}) {
	const address = [
		billing.address_line1,
		billing.address_line2,
		[billing.postal_code, billing.city].filter(Boolean).join(" "),
		country,
	].filter((line) => line.trim());
	const rows: [string, string[]][] = [
		[t`Organisation`, [billing.legal_name]],
		[t`Address`, address],
		[t`Invoice email`, [billing.billing_email]],
		[t`VAT number`, [noVat ? t`We have no VAT number` : billing.vat_id]],
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
