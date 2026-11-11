import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Group,
	NumberInput,
	Paper,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
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
	/** Charged; optional (shown with its price, not counted); included (shown, no price). */
	kind: LineKind;
	/**
	 * The heading the line sits under, or null on an offer without sections. Lines of one
	 * section share its id and sit together; the title is sent on each.
	 */
	section: Section | null;
	/** An optional line's option name; the customer may tick it when signing. Empty for none. */
	option: string;
}

export type LineKind = "charged" | "optional" | "included";

export interface Section {
	id: string;
	title: string;
}

export const emptyLine = (): Line => ({
	bullets: "",
	description: "",
	discount: false,
	id: crypto.randomUUID(),
	kind: "charged",
	option: "",
	quantity: 1,
	section: null,
	unit: "",
	unitPrice: 0,
	vatPercent: 21,
});

export const cents = (euros: number) => Math.round(euros * 100);

/**
 * A line's own amount, in cents: below zero for a discount, zero when included. A quantity
 * may have two decimals; the amount rounds to the cent half up, as the API does.
 */
export const lineAmount = (l: Line) =>
	l.kind === "included"
		? 0
		: Math.round((Math.round(l.quantity * 100) * cents(l.unitPrice)) / 100) *
			(l.discount ? -1 : 1);

/** What a line counts toward the total, in cents: only a charged line counts. */
export const lineCents = (l: Line) =>
	l.kind === "charged" ? lineAmount(l) : 0;

/** The editor's lines from the contract's OfferItem list. */
export const toLines = (
	items: readonly {
		bullets: readonly string[];
		description: string;
		quantity: number;
		unit?: string | null;
		unit_price_cents: number;
		vat_rate_bps: number;
		kind?: "optional" | "included" | null;
		section?: string | null;
		option?: string | null;
	}[],
): Line[] => {
	// Lines under the same heading, one after another, are one section.
	const ids: string[] = [];
	return items.map((item, i) => {
		const same =
			i > 0 && item.section && items[i - 1]?.section === item.section;
		ids[i] = same ? (ids[i - 1] as string) : crypto.randomUUID();
		return {
			bullets: item.bullets.join("\n"),
			description: item.description,
			discount: item.unit_price_cents < 0,
			id: crypto.randomUUID(),
			kind: item.kind ?? "charged",
			option: item.option ?? "",
			quantity: item.quantity,
			section: item.section
				? { id: ids[i] as string, title: item.section }
				: null,
			unit: item.unit ?? "",
			unitPrice: Math.abs(item.unit_price_cents) / 100,
			vatPercent: item.vat_rate_bps / 100,
		};
	});
};

/** The contract's OfferItem list. */
export const toItems = (lines: Line[]) =>
	lines.map((l) => ({
		bullets: l.bullets
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean),
		description: l.description,
		quantity: l.quantity,
		...(l.kind !== "charged" && { kind: l.kind }),
		...(l.section && { section: l.section.title.trim() }),
		...(l.kind === "optional" &&
			l.option.trim() && { option: l.option.trim() }),
		...(l.unit.trim() && { unit: l.unit.trim() }),
		// An included line has no price; the one typed stays in the form for a switch back.
		unit_price_cents:
			l.kind === "included" ? 0 : cents(l.unitPrice) * (l.discount ? -1 : 1),
		vat_rate_bps: Math.round(l.vatPercent * 100),
	}));

/** Consecutive lines of one section (or all lines, without sections), with their indexes. */
const blocksOf = (lines: Line[]) => {
	const out: { section: Section | null; at: number[] }[] = [];
	lines.forEach((l, i) => {
		const last = out.at(-1);
		if (last && last.section?.id === l.section?.id) last.at.push(i);
		else out.push({ at: [i], section: l.section });
	});
	return out;
};

/**
 * The offer lines, shared by "Push offer" and the demo's "Prepare an offer". `discounts`
 * adds discount lines and the choice per line of charged, optional or included;
 * `sections` lets staff put lines under headings, each with its subtotal; `vatFixed`
 * holds every line at 0% (reverse charge, outside the EU).
 */
export function LinesEditor({
	lines,
	onChange,
	errors = {},
	currency = "EUR",
	discounts = false,
	sections = false,
	choices = false,
	vatFixed = false,
}: {
	lines: Line[];
	onChange: (update: (lines: Line[]) => Line[]) => void;
	errors?: Record<string, string>;
	currency?: string;
	discounts?: boolean;
	sections?: boolean;
	/** An optional line can be named as an option the customer ticks when signing. */
	choices?: boolean;
	vatFixed?: boolean;
}) {
	const { i18n } = useLingui();
	const setLines = onChange;
	const fields = errors;
	const update = (i: number, patch: Partial<Line>) =>
		setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
	const money = (c: number) => formatMoney(c, currency, i18n.locale);
	// The bullets box shows on a line that has bullets, or once staff ask for it.
	const [bulletsOpen, setBulletsOpen] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const showBullets = (l: Line) =>
		Boolean(l.bullets.trim()) || bulletsOpen.has(l.id);
	const blocks = blocksOf(lines);
	const sectioned = lines.some((l) => l.section);
	/** A new line at the end of a section (the last one when not given). */
	const addLine = (section: Section | null, over: Partial<Line> = {}) =>
		setLines((ls) => {
			const last = section
				? ls.map((l) => l.section?.id).lastIndexOf(section.id)
				: -1;
			const at = last >= 0 ? last + 1 : ls.length;
			const line = { ...emptyLine(), section, ...over };
			return [...ls.slice(0, at), line, ...ls.slice(at)];
		});
	/** A new section with one empty line; the first puts the lines so far under a heading too. */
	const addSection = () =>
		setLines((ls) => {
			const next: Section = { id: crypto.randomUUID(), title: "" };
			if (ls.some((l) => l.section))
				return [...ls, { ...emptyLine(), section: next }];
			const first: Section = { id: crypto.randomUUID(), title: "" };
			const blank =
				ls.length === 1 && !ls[0]?.description.trim() && !ls[0]?.unitPrice;
			if (blank) return ls.map((l) => ({ ...l, section: first }));
			return [
				...ls.map((l) => ({ ...l, section: first })),
				{ ...emptyLine(), section: next },
			];
		});
	const renameSection = (id: string, title: string) =>
		setLines((ls) =>
			ls.map((l) =>
				l.section?.id === id ? { ...l, section: { id, title } } : l,
			),
		);
	/** A section goes with its lines; without sections left, the offer has one plain line. */
	const removeSection = (id: string) =>
		setLines((ls) => {
			const rest = ls.filter((l) => l.section?.id !== id);
			return rest.length ? rest : [emptyLine()];
		});

	const card = (line: Line, i: number) => (
		<Paper key={line.id} withBorder p="sm" radius="md" data-testid="offer-line">
			<Stack gap="xs">
				<Group align="flex-end" gap="xs" wrap="nowrap">
					<TextInput
						label={t`Description`}
						style={{ flex: 1 }}
						value={line.description}
						onChange={(e) => update(i, { description: e.currentTarget.value })}
						error={fields[`items.${i}.description`]}
						data-testid="line-description"
					/>
					{discounts && !line.discount && (
						<Stack gap={4}>
							<Text size="sm">
								<Trans>Price</Trans>
							</Text>
							<SegmentedControl
								size="sm"
								value={line.kind}
								onChange={(v) => update(i, { kind: v as LineKind })}
								data={[
									{ label: t`Charged`, value: "charged" },
									{ label: t`Optional`, value: "optional" },
									{ label: t`Included`, value: "included" },
								]}
								data-testid="line-kind"
							/>
						</Stack>
					)}
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
				{showBullets(line) ? (
					<Textarea
						label={t`Bullets`}
						description={t`One per line`}
						autosize
						minRows={2}
						value={line.bullets}
						onChange={(e) => update(i, { bullets: e.currentTarget.value })}
						data-testid="line-bullets"
					/>
				) : (
					<Button
						variant="subtle"
						size="xs"
						style={{ alignSelf: "flex-start" }}
						onClick={() => setBulletsOpen((s) => new Set(s).add(line.id))}
						data-testid="line-add-bullets"
					>
						<Trans>Add bullets</Trans>
					</Button>
				)}
				{choices && line.kind === "optional" && (
					<TextInput
						label={t`Option name`}
						description={t`Empty: not ticked at signing`}
						placeholder={t`Scenario A`}
						maxLength={60}
						value={line.option}
						onChange={(e) => update(i, { option: e.currentTarget.value })}
						error={fields[`items.${i}.option`]}
						data-testid="line-option"
					/>
				)}
				<SimpleGrid cols={{ base: 2, sm: 5 }} spacing="xs">
					<NumberInput
						label={t`Quantity`}
						min={0.01}
						decimalScale={2}
						value={line.quantity}
						onChange={(v) => update(i, { quantity: Number(v) || 1 })}
						error={fields[`items.${i}.quantity`]}
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
						value={line.kind === "included" ? 0 : line.unitPrice}
						disabled={line.kind === "included"}
						onChange={(v) => update(i, { unitPrice: Math.abs(Number(v)) || 0 })}
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
							{line.kind === "optional" ? (
								<Trans>Not in the total</Trans>
							) : (
								<Trans>Line total</Trans>
							)}
						</Text>
						<Text size="sm" data-testid="line-total">
							{line.kind === "included" ? (
								<Trans>Included</Trans>
							) : (
								money(lineAmount(line))
							)}
						</Text>
					</Stack>
				</SimpleGrid>
			</Stack>
		</Paper>
	);

	return (
		<Stack gap="sm">
			{blocks.map((block) =>
				block.section ? (
					<Stack key={block.section.id} gap="xs" data-testid="offer-section">
						<Group align="flex-end" gap="xs" wrap="nowrap">
							<TextInput
								label={t`Section`}
								placeholder={t`Co-development`}
								style={{ flex: 1 }}
								value={block.section.title}
								maxLength={120}
								onChange={(e) =>
									renameSection(
										(block.section as Section).id,
										e.currentTarget.value,
									)
								}
								error={fields[`items.${block.at[0]}.section`]}
								data-testid="section-title"
							/>
							<Stack gap={2} pb={6}>
								<Text size="xs" c="dimmed">
									<Trans>Subtotal</Trans>
								</Text>
								<Text size="sm" data-testid="section-subtotal">
									{money(
										block.at.reduce(
											(sum, i) => sum + lineCents(lines[i] as Line),
											0,
										),
									)}
								</Text>
							</Stack>
							<ActionIcon
								variant="subtle"
								color="gray"
								aria-label={t`Remove section`}
								onClick={() => removeSection((block.section as Section).id)}
								mb={4}
							>
								<TrashIcon size={16} />
							</ActionIcon>
						</Group>
						<Stack gap="sm" pl="md">
							{block.at.map((i) => card(lines[i] as Line, i))}
							<Button
								variant="subtle"
								size="xs"
								style={{ alignSelf: "flex-start" }}
								onClick={() => addLine(block.section)}
								data-testid="section-add-line"
							>
								<Trans>Add a line</Trans>
							</Button>
						</Stack>
					</Stack>
				) : (
					block.at.map((i) => card(lines[i] as Line, i))
				),
			)}
			<Group gap="xs">
				{!sectioned && (
					<Button variant="subtle" size="xs" onClick={() => addLine(null)}>
						<Trans>Add a line</Trans>
					</Button>
				)}
				{discounts && (
					<Button
						variant="subtle"
						size="xs"
						onClick={() =>
							addLine(lines.at(-1)?.section ?? null, {
								description: t`Discount`,
								discount: true,
								vatPercent: lines[0]?.vatPercent ?? 21,
							})
						}
						data-testid="add-discount"
					>
						<Trans>Add a discount</Trans>
					</Button>
				)}
				{sections && (
					<Button
						variant="subtle"
						size="xs"
						onClick={addSection}
						data-testid="add-section"
					>
						<Trans>Add a section</Trans>
					</Button>
				)}
			</Group>
		</Stack>
	);
}
