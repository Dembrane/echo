import { t } from "@lingui/core/macro";
import { Select } from "@mantine/core";
import { useMemo } from "react";

interface PeriodSelectProps {
	value: number; // month_offset: 0 = current, 1 = last month, …
	onChange: (offset: number) => void;
	monthsBack?: number;
	size?: "xs" | "sm" | "md";
}

function monthLabel(offset: number): string {
	const d = new Date();
	d.setDate(1);
	d.setMonth(d.getMonth() - offset);
	if (offset === 0) return t`This month`;
	if (offset === 1) return t`Last month`;
	return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Compact month picker used on usage surfaces. `value` is the backend
 * `month_offset` — 0 = current, 1 = last, etc. Six months back covers
 * the common "did we go over last quarter" audit without bloating the
 * dropdown or the cache-key space.
 */
export const PeriodSelect = ({
	value,
	onChange,
	monthsBack = 6,
	size = "xs",
}: PeriodSelectProps) => {
	const data = useMemo(
		() =>
			Array.from({ length: monthsBack + 1 }, (_, i) => ({
				value: String(i),
				label: monthLabel(i),
			})),
		[monthsBack],
	);

	return (
		<Select
			size={size}
			data={data}
			value={String(value)}
			onChange={(v) => onChange(Number(v ?? 0))}
			allowDeselect={false}
			style={{ minWidth: 140 }}
			aria-label={t`Period`}
		/>
	);
};
