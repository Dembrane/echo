import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, Stack, Switch, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
	PaperPlaneTiltIcon,
	PlugsConnectedIcon,
	TrayArrowUpIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { call } from "../api/client";
import type { AccountPageT } from "../contract/contract.gen";

type Billing = AccountPageT["billing"];
export type Delivery = NonNullable<Billing["invoice_delivery"]>;
/** What Exact sends by itself; a portal is a person's work, so nothing switches to it. */
export type SentDelivery = Exclude<Delivery, "portal">;
export type PeppolMatch = NonNullable<Billing["peppol_match"]>;

/**
 * Their own portal when they chose it. Else Peppol first: when the directory knows the
 * customer, invoices go there unless they chose email. Without a match invoices go by
 * email.
 */
export const deliveryFor = (
	match: PeppolMatch | null,
	chosen: Delivery | null | undefined,
): Delivery =>
	chosen === "portal" ? "portal" : match ? (chosen ?? "peppol") : "email";

type Numbers = Pick<Billing, "vat_id" | "kvk_number" | "kbo_number">;

/**
 * Looks the registration numbers up in the Peppol directory while they are typed, once
 * the typing pauses. A failed lookup counts as no match: the form never waits on it.
 */
export function usePeppolLookup(orgId: string, numbers: Numbers) {
	const [settled] = useDebouncedValue(numbers, 600);
	const any = Boolean(
		settled.vat_id?.trim() ||
			settled.kvk_number?.trim() ||
			settled.kbo_number?.trim(),
	);
	const query = useQuery({
		enabled: any,
		queryFn: async () => {
			try {
				return (
					await call("lookupPeppol", { body: settled, params: { orgId } })
				).match;
			} catch {
				return null;
			}
		},
		queryKey: ["accounts", "peppol-lookup", orgId, settled],
		staleTime: 5 * 60_000,
	});
	const typing =
		numbers.vat_id !== settled.vat_id ||
		numbers.kvk_number !== settled.kvk_number ||
		numbers.kbo_number !== settled.kbo_number;
	return {
		checking: any && (typing || query.isFetching),
		match: any ? (query.data ?? null) : null,
	};
}

/**
 * How invoices arrive, said plainly, for saved details. On Peppol there is one choice to
 * make here: send by email instead. A portal has none: we add each invoice there by hand,
 * and the line says so. Shared by the billing summary and the staff card (`side` words it
 * for whoever is reading).
 */
export function InvoiceDelivery({
	match,
	delivery,
	email,
	portal = null,
	onChange,
	disabled = false,
	side = "customer",
}: {
	match: PeppolMatch | null;
	delivery: Delivery;
	email: string | null;
	portal?: string | null;
	/** Absent: the line is read-only. */
	onChange?: (next: SentDelivery) => void;
	disabled?: boolean;
	side?: "customer" | "staff";
}) {
	if (delivery !== "portal" && !match) return null;
	const peppol = delivery === "peppol";
	const id = match?.participant_id;
	return (
		<Stack
			gap="sm"
			py="sm"
			data-testid="invoice-delivery"
			data-delivery={delivery}
			style={{
				borderBottom: "var(--app-stroke) solid var(--app-quiet)",
				borderTop: "var(--app-stroke) solid var(--app-quiet)",
			}}
		>
			<Group gap="sm" wrap="nowrap" align="flex-start">
				<Text
					c={peppol ? "var(--app-action)" : "var(--app-muted)"}
					pt="xs"
					style={{ flexShrink: 0, lineHeight: 0 }}
				>
					{delivery === "portal" ? (
						<TrayArrowUpIcon size={20} aria-hidden />
					) : peppol ? (
						<PlugsConnectedIcon size={20} aria-hidden />
					) : (
						<PaperPlaneTiltIcon size={20} aria-hidden />
					)}
				</Text>
				<Text style={{ overflowWrap: "anywhere" }}>
					{delivery === "portal" ? (
						side === "customer" ? (
							<Trans>
								Invoices go to your invoice portal: {portal}. Someone at
								dembrane adds each one by hand.
							</Trans>
						) : (
							<Trans>
								Invoices go to the customer's invoice portal: {portal}. Add each
								one there by hand.
							</Trans>
						)
					) : peppol ? (
						side === "customer" ? (
							<Trans>
								Invoices arrive in your accounting software via Peppol ({id}).
							</Trans>
						) : (
							<Trans>Invoices go via Peppol ({id}).</Trans>
						)
					) : email ? (
						<Trans>
							Invoices go by email to {email}, not via Peppol ({id}).
						</Trans>
					) : (
						<Trans>Invoices go by email, not via Peppol ({id}).</Trans>
					)}
				</Text>
			</Group>
			{onChange && delivery !== "portal" && (
				<Switch
					checked={!peppol}
					disabled={disabled}
					onChange={(e) =>
						onChange(e.currentTarget.checked ? "email" : "peppol")
					}
					label={t`Send by email instead`}
					data-testid="delivery-email"
				/>
			)}
		</Stack>
	);
}
