import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Button,
	Group,
	NumberInput,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { TrashIcon } from "@phosphor-icons/react";
import type { DocumentDetailT } from "../contract/contract.gen";
import { formatMoney } from "../format";

type Saved = NonNullable<
	NonNullable<DocumentDetailT["content"]>["invoice_plan"]
>;

/** One instalment as typed: on signing or a date, and its share in percent. */
export interface InstalmentRow {
	id: string;
	on: "signing" | "date";
	date: string;
	percent: number;
}

/** The plan as the form holds it; `once` invoices the whole offer when it is signed. */
export interface PlanForm {
	kind: "once" | "monthly" | "instalments";
	months: number;
	rows: InstalmentRow[];
}

const row = (over: Partial<InstalmentRow> = {}): InstalmentRow => ({
	date: "",
	id: crypto.randomUUID(),
	on: "date",
	percent: 50,
	...over,
});

export const planForm = (saved?: Saved | null): PlanForm => ({
	kind: saved?.kind ?? "once",
	months: saved?.kind === "monthly" ? saved.parts : 12,
	rows:
		saved?.kind === "instalments"
			? saved.parts.map((p) =>
					row({
						date: p.on === "signing" ? "" : p.on,
						on: p.on === "signing" ? "signing" : "date",
						percent: p.share_bps / 100,
					}),
				)
			: [row({ on: "signing" }), row()],
});

/** The request's `invoice_plan`: null invoices at once. Percent goes as basis points. */
export const planBody = (f: PlanForm) =>
	f.kind === "monthly"
		? { kind: "monthly" as const, parts: f.months }
		: f.kind === "instalments"
			? {
					kind: "instalments" as const,
					parts: f.rows.map((r) => ({
						on: r.on === "signing" ? "signing" : r.date,
						share_bps: Math.round(r.percent * 100),
					})),
				}
			: null;

/**
 * Staff: how the offer is invoiced. At once is the default; monthly cuts the total into
 * equal parts, the first on signing; instalments each fall on signing (the first only) or
 * on a date, with a share. The last part takes the cents rounding leaves, as the API does.
 */
export function InvoicePlanFields({
	value,
	onChange,
	net,
	currency,
	errors,
}: {
	value: PlanForm;
	onChange: (f: PlanForm) => void;
	/** The offer's subtotal in cents, to show what each part comes to. */
	net: number;
	currency: string;
	errors: Record<string, string>;
}) {
	const { i18n } = useLingui();
	const money = (cents: number) => formatMoney(cents, currency, i18n.locale);
	const set = (patch: Partial<PlanForm>) => onChange({ ...value, ...patch });
	const setRow = (i: number, patch: Partial<InstalmentRow>) =>
		set({
			rows: value.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
		});
	const totalBps = value.rows.reduce(
		(s, r) => s + Math.round(r.percent * 100),
		0,
	);
	const months = Math.max(2, value.months || 2);
	const monthly = Math.floor(net / months);

	return (
		<Stack gap="xs" data-testid="offer-invoice-plan">
			<Group gap="sm" align="center" wrap="wrap">
				<Text size="sm">{t`How we invoice`}</Text>
				<SegmentedControl
					size="xs"
					value={value.kind}
					onChange={(v) => set({ kind: v as PlanForm["kind"] })}
					data={[
						{ label: t`At once`, value: "once" },
						{ label: t`Monthly`, value: "monthly" },
						{ label: t`In instalments`, value: "instalments" },
					]}
					data-testid="invoice-plan-kind"
				/>
			</Group>
			{value.kind === "monthly" && (
				<Group gap="sm" align="flex-end">
					<NumberInput
						label={t`Number of months`}
						min={2}
						max={24}
						w={160}
						value={value.months}
						onChange={(v) => set({ months: Number(v) || 2 })}
						error={errors["invoice_plan.parts"]}
						data-testid="invoice-plan-months"
					/>
					<Text size="xs" c="dimmed" pb={8}>
						{t`${months} × ${money(monthly)}, first on signing`}
					</Text>
				</Group>
			)}
			{value.kind === "instalments" && (
				<Stack gap="xs">
					{value.rows.map((r, i) => (
						<Group
							key={r.id}
							gap="sm"
							align="flex-end"
							wrap="nowrap"
							data-testid="invoice-plan-row"
						>
							{i === 0 ? (
								<Select
									label={t`When`}
									w={150}
									value={r.on}
									onChange={(v) =>
										v && setRow(i, { on: v as InstalmentRow["on"] })
									}
									data={[
										{ label: t`On signing`, value: "signing" },
										{ label: t`On a date`, value: "date" },
									]}
									allowDeselect={false}
									data-testid="invoice-plan-when"
								/>
							) : null}
							{(i > 0 || r.on === "date") && (
								<TextInput
									label={t`Date`}
									type="date"
									w={160}
									value={r.date}
									onChange={(e) => setRow(i, { date: e.currentTarget.value })}
									error={errors[`invoice_plan.parts.${i}.on`]}
									data-testid="invoice-plan-date"
								/>
							)}
							<NumberInput
								label={t`Share (%)`}
								min={0.01}
								max={100}
								decimalScale={2}
								w={110}
								value={r.percent}
								onChange={(v) => setRow(i, { percent: Number(v) || 0 })}
								data-testid="invoice-plan-share"
							/>
							<Text size="sm" c="dimmed" pb={8}>
								{money(
									Math.floor((net * Math.round(r.percent * 100)) / 10_000),
								)}
							</Text>
							{value.rows.length > 2 && (
								<ActionIcon
									variant="subtle"
									color="gray"
									aria-label={t`Remove part`}
									onClick={() =>
										set({ rows: value.rows.filter((_, j) => j !== i) })
									}
									mb={6}
								>
									<TrashIcon size={16} />
								</ActionIcon>
							)}
						</Group>
					))}
					<Group gap="sm">
						{value.rows.length < 12 && (
							<Button
								variant="subtle"
								size="xs"
								onClick={() =>
									set({ rows: [...value.rows, row({ percent: 0 })] })
								}
								data-testid="invoice-plan-add"
							>
								{t`Add a part`}
							</Button>
						)}
						<Text
							size="xs"
							c={totalBps === 10_000 ? "dimmed" : "red"}
							data-testid="invoice-plan-total"
						>
							{t`Shares add up to ${totalBps / 100}%`}
						</Text>
					</Group>
				</Stack>
			)}
		</Stack>
	);
}
