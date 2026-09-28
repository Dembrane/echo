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
	unitPrice: number;
	vatPercent: number;
}

export const emptyLine = (): Line => ({
	bullets: "",
	description: "",
	id: crypto.randomUUID(),
	quantity: 1,
	unitPrice: 0,
	vatPercent: 21,
});

export const cents = (euros: number) => Math.round(euros * 100);

/** The contract's OfferItem list. */
export const toItems = (lines: Line[]) =>
	lines.map((l) => ({
		bullets: l.bullets
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean),
		description: l.description,
		quantity: l.quantity,
		unit_price_cents: cents(l.unitPrice),
		vat_rate_bps: Math.round(l.vatPercent * 100),
	}));

/** The offer lines, shared by "Push offer" and the demo's "Prepare an offer". */
export function LinesEditor({
	lines,
	onChange,
	errors = {},
}: {
	lines: Line[];
	onChange: (update: (lines: Line[]) => Line[]) => void;
	errors?: Record<string, string>;
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
						<SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
							<NumberInput
								label={t`Quantity`}
								min={1}
								value={line.quantity}
								onChange={(v) => update(i, { quantity: Number(v) || 1 })}
								data-testid="line-quantity"
							/>
							<NumberInput
								label={t`Unit price (EUR)`}
								min={0}
								decimalScale={2}
								value={line.unitPrice}
								onChange={(v) => update(i, { unitPrice: Number(v) || 0 })}
								data-testid="line-price"
							/>
							<NumberInput
								label={t`VAT %`}
								min={0}
								max={100}
								value={line.vatPercent}
								onChange={(v) => update(i, { vatPercent: Number(v) || 0 })}
							/>
							<Stack gap={2} justify="flex-end">
								<Text size="xs" c="dimmed">
									<Trans>Line total</Trans>
								</Text>
								<Text size="sm">
									{formatMoney(
										line.quantity * cents(line.unitPrice),
										"EUR",
										i18n.locale,
									)}
								</Text>
							</Stack>
						</SimpleGrid>
					</Stack>
				</Paper>
			))}
			<Button
				variant="subtle"
				size="xs"
				onClick={() => setLines((ls) => [...ls, emptyLine()])}
				style={{ alignSelf: "flex-start" }}
			>
				<Trans>Add a line</Trans>
			</Button>
		</Stack>
	);
}
