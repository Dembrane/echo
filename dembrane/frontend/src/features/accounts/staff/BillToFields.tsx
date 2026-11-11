import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Checkbox, Select, SimpleGrid, Stack, TextInput } from "@mantine/core";
import { useMemo } from "react";
import { COUNTRY_CODES, countryName } from "../contract/billing-rules.gen";
import type { DocumentDetailT } from "../contract/contract.gen";

type Saved = NonNullable<NonNullable<DocumentDetailT["content"]>["bill_to"]>;

/** The party as the form holds it: every field as typed, empty when not given. */
export interface BillToForm {
	name: string;
	address: string;
	postal_code: string;
	city: string;
	country_code: string;
	vat_id: string;
	email: string;
	reference: string;
}

export const billToForm = (saved?: Saved | null): BillToForm => ({
	address: saved?.address ?? "",
	city: saved?.city ?? "",
	country_code: saved?.country_code ?? "NL",
	email: saved?.email ?? "",
	name: saved?.name ?? "",
	postal_code: saved?.postal_code ?? "",
	reference: saved?.reference ?? "",
	vat_id: saved?.vat_id ?? "",
});

/** The request's `bill_to`: null when the customer pays, empty optional fields left out. */
export const billToBody = (on: boolean, f: BillToForm) =>
	on
		? {
				address: f.address.trim(),
				city: f.city.trim(),
				country_code: f.country_code,
				email: f.email.trim(),
				name: f.name.trim(),
				postal_code: f.postal_code.trim() || null,
				reference: f.reference.trim() || null,
				vat_id: f.vat_id.trim() || null,
			}
		: null;

/**
 * Staff: who is invoiced when it is not the customer (an agency, a sponsor, the customer's
 * other entity). Off by default; on, the party's details sit under the box, and the offer
 * prints them as "Invoiced to" for the customer to see before signing.
 */
export function BillToFields({
	on,
	onToggle,
	value,
	onChange,
	errors,
}: {
	on: boolean;
	onToggle: (on: boolean) => void;
	value: BillToForm;
	onChange: (f: BillToForm) => void;
	errors: Record<string, string>;
}) {
	const { i18n } = useLingui();
	const countries = useMemo(() => {
		const collator = new Intl.Collator(i18n.locale);
		return COUNTRY_CODES.map((code) => ({
			label: countryName(code, i18n.locale),
			value: code,
		})).sort((a, b) => collator.compare(a.label, b.label));
	}, [i18n.locale]);
	const set = (patch: Partial<BillToForm>) => onChange({ ...value, ...patch });
	const err = (k: keyof BillToForm) => errors[`bill_to.${k}`];

	return (
		<Stack gap="sm" data-testid="offer-bill-to">
			<Checkbox
				label={t`Invoice another organisation`}
				description={t`Shown on the offer before signing`}
				checked={on}
				onChange={(e) => onToggle(e.currentTarget.checked)}
				data-testid="offer-bill-to-toggle"
			/>
			{on && (
				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
					<TextInput
						label={t`Organisation`}
						value={value.name}
						onChange={(e) => set({ name: e.currentTarget.value })}
						error={err("name")}
						maxLength={200}
						data-testid="bill-to-name"
					/>
					<TextInput
						label={t`Invoice email`}
						type="email"
						value={value.email}
						onChange={(e) => set({ email: e.currentTarget.value })}
						error={err("email")}
						maxLength={255}
						data-testid="bill-to-email"
					/>
					<TextInput
						label={t`Address`}
						value={value.address}
						onChange={(e) => set({ address: e.currentTarget.value })}
						error={err("address")}
						maxLength={200}
						data-testid="bill-to-address"
					/>
					<SimpleGrid cols={2} spacing="sm">
						<TextInput
							label={t`Postal code`}
							value={value.postal_code}
							onChange={(e) => set({ postal_code: e.currentTarget.value })}
							error={err("postal_code")}
							maxLength={20}
							data-testid="bill-to-postal-code"
						/>
						<TextInput
							label={t`City`}
							value={value.city}
							onChange={(e) => set({ city: e.currentTarget.value })}
							error={err("city")}
							maxLength={100}
							data-testid="bill-to-city"
						/>
					</SimpleGrid>
					<Select
						label={t`Country`}
						placeholder={t`Choose a country`}
						data={countries}
						value={value.country_code}
						onChange={(code) => code && set({ country_code: code })}
						error={err("country_code")}
						allowDeselect={false}
						searchable
						data-testid="bill-to-country"
					/>
					<TextInput
						label={t`VAT number`}
						placeholder={t`Optional`}
						value={value.vat_id}
						onChange={(e) => set({ vat_id: e.currentTarget.value })}
						error={err("vat_id")}
						maxLength={32}
						data-testid="bill-to-vat"
					/>
					<TextInput
						label={t`Their reference`}
						description={t`PO, order or project number`}
						value={value.reference}
						onChange={(e) => set({ reference: e.currentTarget.value })}
						error={err("reference")}
						maxLength={64}
						data-testid="bill-to-reference"
					/>
				</SimpleGrid>
			)}
		</Stack>
	);
}
