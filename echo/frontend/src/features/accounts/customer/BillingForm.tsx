import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
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
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import type { AccountPageT } from "../contract/contract.gen";
import { Section } from "../ui";

type Billing = AccountPageT["billing"];
type Key = keyof Billing;

const toForm = (b: Billing): Record<Key, string> =>
	Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v ?? ""])) as Record<
		Key,
		string
	>;

/**
 * The details Exact needs to invoice: who, where, a registration number (VAT, KvK or KBO,
 * at least one), and what the customer's finance team wants on the invoice.
 */
export function BillingForm({
	orgId,
	billing,
}: {
	orgId: string;
	billing: Billing;
}) {
	const [form, setForm] = useState(() => toForm(billing));
	const [localError, setLocalError] = useState<string | null>(null);
	useEffect(() => setForm(toForm(billing)), [billing]);
	const mutation = useAccountsMutation("updateBilling", { orgId });
	const serverFields =
		mutation.error instanceof AccountsApiError ? mutation.error.fields : {};
	const errorOf = (key: Key) => serverFields[key];
	const dirty = Object.entries(toForm(billing)).some(
		([k, v]) => form[k as Key] !== v,
	);

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
			}}
			error={errorOf(key)}
			data-testid={`billing-${key}`}
			{...props}
		/>
	);

	const save = () => {
		setLocalError(null);
		if (
			!form.vat_id.trim() &&
			!form.kvk_number.trim() &&
			!form.kbo_number.trim()
		) {
			setLocalError(t`Give a VAT, KvK or KBO number.`);
			return;
		}
		mutation.mutate(
			{ body: form },
			{ onSuccess: () => toast.success(t`Billing details saved`) },
		);
	};

	return (
		<Section title={<Trans>Billing details</Trans>} testId="billing">
			<Box maw={640}>
				<Stack gap="md">
					<SimpleGrid
						cols={{ base: 1, sm: 2 }}
						spacing="sm"
						verticalSpacing="sm"
					>
						{input("legal_name", t`Legal name`, {
							autoComplete: "organization",
							required: true,
						})}
						{input("billing_email", t`Invoice email`, {
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
					<Stack gap={4}>
						<SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
							{input("vat_id", t`VAT number`, {
								error: errorOf("vat_id") ?? (localError ? true : undefined),
							})}
							{input("kvk_number", t`KvK number`, {
								error: localError ? true : undefined,
							})}
							{input("kbo_number", t`KBO number`, {
								error: localError ? true : undefined,
							})}
						</SimpleGrid>
						<Text size="xs" c={localError ? "red" : "dimmed"}>
							{localError ?? <Trans>At least one of the three.</Trans>}
						</Text>
					</Stack>
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
						{input("po_number", t`PO number`, {
							description: t`If your finance team uses one`,
						})}
						{input("peppol_id", t`Peppol ID`, {
							description: t`For e-invoicing`,
						})}
					</SimpleGrid>
					<Group>
						<Button
							onClick={save}
							loading={mutation.isPending}
							disabled={!dirty}
							data-testid="billing-save"
						>
							<Trans>Save billing details</Trans>
						</Button>
						{mutation.error &&
							!(
								mutation.error instanceof AccountsApiError &&
								Object.keys(serverFields).length
							) && (
								<Text size="sm" c="red">
									{mutation.error.message}
								</Text>
							)}
					</Group>
				</Stack>
			</Box>
		</Section>
	);
}
