import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Group,
	NumberInput,
	Paper,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { TrashIcon } from "@phosphor-icons/react";
import { formatMoney } from "../format";

/** One offer line as staff edit it: euros and percent, converted to cents and bps on send. */
export interface Line {
	id: string;
	description: string;
	bullets: string;
	quantity: number;
	/** What the quantity counts ("months", "hours"); empty for none. */
	unit: string;
	/** Always zero or more; a discount line takes it off the total. */
	unitPrice: number;
	vatPercent: number;
	/** A discount: sent as a negative unit price. */
	discount: boolean;
}

export const emptyLine = (): Line => ({
	bullets: "",
	description: "",
	discount: false,
	id: crypto.randomUUID(),
	quantity: 1,
	unit: "",
	unitPrice: 0,
	vatPercent: 21,
});

export const cents = (euros: number) => Math.round(euros * 100);

/** What a line counts toward the total, in cents: below zero for a discount. */
export const lineCents = (l: Line) =>
	l.quantity * cents(l.unitPrice) * (l.discount ? -1 : 1);

/** The editor's lines from the contract's OfferItem list. */
export const toLines = (
	items: readonly {
		bullets: readonly string[];
		description: string;
		quantity: number;
		unit?: string | null;
		unit_price_cents: number;
		vat_rate_bps: number;
	}[],
): Line[] =>
	items.map((item) => ({
		bullets: item.bullets.join("\n"),
		description: item.description,
		discount: item.unit_price_cents < 0,
		id: crypto.randomUUID(),
		quantity: item.quantity,
		unit: item.unit ?? "",
		unitPrice: Math.abs(item.unit_price_cents) / 100,
		vatPercent: item.vat_rate_bps / 100,
	}));

/** The contract's OfferItem list. */
export const toItems = (lines: Line[]) =>
	lines.map((l) => ({
		bullets: l.bullets
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean),
		description: l.description,
		quantity: l.quantity,
		...(l.unit.trim() && { unit: l.unit.trim() }),
		unit_price_cents: cents(l.unitPrice) * (l.discount ? -1 : 1),
		vat_rate_bps: Math.round(l.vatPercent * 100),
	}));

/**
 * The offer lines, shared by "Push offer" and the demo's "Prepare an offer". `discounts`
 * adds discount lines; `vatFixed` holds every line at 0% (reverse charge, outside the EU).
 */
export function LinesEditor({
	lines,
	onChange,
	errors = {},
	currency = "EUR",
	discounts = false,
	vatFixed = false,
}: {
	lines: Line[];
	onChange: (update: (lines: Line[]) => Line[]) => void;
	errors?: Record<string, string>;
	currency?: string;
	discounts?: boolean;
	vatFixed?: boolean;
}) {
	const { i18n } = useLingui();
	const setLines = onChange;
	const fields = errors;
	const update = (i: number, patch: Partial<Line>) =>
		setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
	return (
		<Stack gap="sm">
			{lines.map((line, i) => (
				<Paper
					key={line.id}
					withBorder
					p="sm"
					radius="md"
					data-testid="offer-line"
				>
					<Stack gap="xs">
						<Group align="flex-end" gap="xs" wrap="nowrap">
							<TextInput
								label={t`Description`}
								style={{ flex: 1 }}
								value={line.description}
								onChange={(e) =>
									update(i, { description: e.currentTarget.value })
								}
								error={fields[`items.${i}.description`]}
								data-testid="line-description"
							/>
							{lines.length > 1 && (
								<ActionIcon
									variant="subtle"
									color="gray"
									aria-label={t`Remove line`}
									onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
									mb={4}
								>
									<TrashIcon size={16} />
								</ActionIcon>
							)}
						</Group>
						<Textarea
							label={t`Bullets`}
							description={t`One per line`}
							autosize
							minRows={2}
							value={line.bullets}
							onChange={(e) => update(i, { bullets: e.currentTarget.value })}
						/>
						<SimpleGrid cols={{ base: 2, sm: 5 }} spacing="xs">
							<NumberInput
								label={t`Quantity`}
								min={1}
								value={line.quantity}
								onChange={(v) => update(i, { quantity: Number(v) || 1 })}
								data-testid="line-quantity"
							/>
							<TextInput
								label={t`Unit`}
								value={line.unit}
								onChange={(e) => update(i, { unit: e.currentTarget.value })}
								error={fields[`items.${i}.unit`]}
								data-testid="line-unit"
							/>
							<NumberInput
								label={
									line.discount
										? t`Discount (${currency})`
										: t`Unit price (${currency})`
								}
								min={0}
								decimalScale={2}
								value={line.unitPrice}
								onChange={(v) =>
									update(i, { unitPrice: Math.abs(Number(v)) || 0 })
								}
								data-testid="line-price"
							/>
							<NumberInput
								label={t`VAT %`}
								min={0}
								max={100}
								value={vatFixed ? 0 : line.vatPercent}
								disabled={vatFixed}
								onChange={(v) => update(i, { vatPercent: Number(v) || 0 })}
								data-testid="line-vat"
							/>
							<Stack gap={2} justify="flex-end">
								<Text size="xs" c="dimmed">
									<Trans>Line total</Trans>
								</Text>
								<Text size="sm" data-testid="line-total">
									{formatMoney(lineCents(line), currency, i18n.locale)}
								</Text>
							</Stack>
						</SimpleGrid>
					</Stack>
				</Paper>
			))}
			<Group gap="xs">
				<Button
					variant="subtle"
					size="xs"
					onClick={() => setLines((ls) => [...ls, emptyLine()])}
				>
					<Trans>Add a line</Trans>
				</Button>
				{discounts && (
					<Button
						variant="subtle"
						size="xs"
						onClick={() =>
							setLines((ls) => [
								...ls,
								{
									...emptyLine(),
									description: t`Discount`,
									discount: true,
									vatPercent: ls[0]?.vatPercent ?? 21,
								},
							])
						}
						data-testid="add-discount"
					>
						<Trans>Add a discount</Trans>
					</Button>
				)}
			</Group>
		</Stack>
	);
}
