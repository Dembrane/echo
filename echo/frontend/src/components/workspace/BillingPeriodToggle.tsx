import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, SegmentedControl, Text } from "@mantine/core";
import type { BillingPeriod } from "@/lib/tiers";

/**
 * Shared annual/monthly toggle. Sits above tier pricing cards and the tier
 * capacity matrix on every pricing surface (creation wizard, upgrade modal,
 * admin approval dialog, workspace + admin settings matrix).
 *
 * Fully controlled — parent owns the state. The only place the "10% off"
 * copy lives is here; callers do not duplicate it.
 */

interface BillingPeriodToggleProps {
	value: BillingPeriod;
	onChange: (period: BillingPeriod) => void;
	compact?: boolean;
}

export function BillingPeriodToggle({
	value,
	onChange,
	compact = false,
}: BillingPeriodToggleProps) {
	return (
		<SegmentedControl
			size={compact ? "xs" : "sm"}
			value={value}
			onChange={(v) => onChange(v as BillingPeriod)}
			data={[
				{
					label: (
						<Group gap={6} wrap="nowrap" justify="center">
							<Text size={compact ? "xs" : "sm"}>
								<Trans>Annual billing</Trans>
							</Text>
							<Badge size="xs" variant="light" color="primary">
								<Trans>10% off</Trans>
							</Badge>
						</Group>
					),
					value: "annual",
				},
				{
					label: (
						<Text size={compact ? "xs" : "sm"}>
							<Trans>Monthly billing</Trans>
						</Text>
					),
					value: "monthly",
				},
			]}
			aria-label={t`Billing period`}
		/>
	);
}
