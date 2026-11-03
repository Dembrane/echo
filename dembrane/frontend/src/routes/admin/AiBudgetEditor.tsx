import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	NumberInput,
	Paper,
	Stack,
	Switch,
	Text,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { API_BASE_URL } from "@/config";
import {
	AI_COSTS_QUERY_KEY,
	type AiBudgetOverride,
	eurosToMicro,
	MAX_AI_BUDGET_MICRO_EUR,
	MICRO_PER_EUR,
	microToEuros,
	numberFromInput,
} from "@/hooks/useAiCosts";
import { ensureOk } from "@/lib/errors/read";

// The stored end is the start of the day after the last covered day.
const untilToDate = (until: string | null): Date | null => {
	if (!until) return null;
	const [y, m, d] = until.slice(0, 10).split("-").map(Number);
	if (!y || !m || !d) return null;
	return new Date(y, m - 1, d - 1);
};

const dateToUntil = (lastDay: Date | null): string | null =>
	lastDay ? dayjs(lastDay).add(1, "day").format("YYYY-MM-DD") : null;

const sameOverride = (a: AiBudgetOverride, b: AiBudgetOverride) =>
	a.amount_micro_eur === b.amount_micro_eur &&
	a.unlimited === b.unlimited &&
	a.until?.slice(0, 10) === b.until?.slice(0, 10);

/** Staff override of one account's free AI budget: an amount or no limit, until a date. */
export function AiBudgetEditor({
	accountId,
	current,
}: {
	accountId: string;
	current: AiBudgetOverride;
}) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState<string | number>(
		current.amount_micro_eur === null
			? ""
			: microToEuros(current.amount_micro_eur),
	);
	const [unlimited, setUnlimited] = useState(current.unlimited);
	const [until, setUntil] = useState<Date | null>(untilToDate(current.until));

	const euros = numberFromInput(amount);
	const amountMicro = Number.isFinite(euros) ? eurosToMicro(euros) : null;
	const amountOk =
		amountMicro !== null &&
		amountMicro >= 0 &&
		amountMicro <= MAX_AI_BUDGET_MICRO_EUR;
	const next: AiBudgetOverride = {
		amount_micro_eur: unlimited ? null : amountMicro,
		unlimited,
		until: dateToUntil(until),
	};
	const hasOverride =
		current.unlimited ||
		current.amount_micro_eur !== null ||
		current.until !== null;
	const canSave = (unlimited || amountOk) && !sameOverride(next, current);

	const invalidate = () => {
		void queryClient.invalidateQueries({
			queryKey: ["v2", "admin", "billing-rollup"],
		});
		void queryClient.invalidateQueries({ queryKey: AI_COSTS_QUERY_KEY });
	};
	const path = `${API_BASE_URL}/v2/admin/billing-accounts/${accountId}/ai-budget`;

	const save = useMutation({
		mutationFn: async (body: AiBudgetOverride) =>
			ensureOk(
				await fetch(path, {
					body: JSON.stringify(body),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PUT",
				}),
			),
		onSuccess: () => {
			toast.success(t`AI budget saved`);
			invalidate();
		},
	});
	const clear = useMutation({
		mutationFn: async () =>
			ensureOk(await fetch(path, { credentials: "include", method: "DELETE" })),
		onSuccess: () => {
			toast.success(t`AI budget cleared`);
			invalidate();
		},
	});

	// Today at the earliest: the stored end is then tomorrow.
	const minDate = dayjs().startOf("day").toDate();

	return (
		<Paper withBorder p="sm">
			<Stack gap="xs">
				<Text size="sm">
					<Trans>AI budget</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					{hasOverride ? (
						<Trans>Applies while the account is on the free plan.</Trans>
					) : (
						<Trans>Uses the free plan default.</Trans>
					)}
				</Text>
				<Group gap="sm" align="flex-end" wrap="wrap">
					<NumberInput
						label={t`Amount per month`}
						size="xs"
						w={130}
						min={0}
						max={MAX_AI_BUDGET_MICRO_EUR / MICRO_PER_EUR}
						allowNegative={false}
						decimalScale={2}
						fixedDecimalScale
						prefix="€"
						placeholder={t`Default`}
						value={amount}
						onChange={setAmount}
						disabled={unlimited}
					/>
					<DatePickerInput
						label={t`Until`}
						description={t`Last day on this budget`}
						placeholder={t`No end date`}
						size="xs"
						w={170}
						value={until}
						onChange={setUntil}
						minDate={minDate}
						clearable
					/>
				</Group>
				<Switch
					size="xs"
					label={t`No limit`}
					checked={unlimited}
					onChange={(e) => setUnlimited(e.currentTarget.checked)}
				/>
				{save.isError && <ErrorNotice error={save.error} />}
				{clear.isError && <ErrorNotice error={clear.error} />}
				<Group gap="xs">
					<Button
						size="xs"
						disabled={!canSave}
						loading={save.isPending}
						onClick={() => save.mutate(next)}
					>
						<Trans>Save AI budget</Trans>
					</Button>
					<Button
						size="xs"
						variant="default"
						disabled={!hasOverride}
						loading={clear.isPending}
						onClick={() => clear.mutate()}
					>
						<Trans>Clear</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
