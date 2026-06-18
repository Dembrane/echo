import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, SegmentedControl, Text } from "@mantine/core";
import { type BillingPeriod, MONTHLY_BILLING_PREMIUM_PCT } from "@/lib/tiers";

/**
 * Shared annual/monthly toggle. Sits above tier pricing cards and the tier
 * capacity matrix on every pricing surface (creation wizard, upgrade modal,
 * admin approval dialog, workspace + admin settings matrix).
 *
 * Fully controlled — parent owns the state. The discount badge is driven by
 * MONTHLY_BILLING_PREMIUM_PCT (single knob); callers do not duplicate it.
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
			size={compact ? "sm" : "md"}
			value={value}
			onChange={(v) => onChange(v as BillingPeriod)}
			styles={{
				control: { overflow: "visible" },
				label: {
					overflow: "visible",
					paddingInline: 18,
					textOverflow: "clip",
				},
				root: { overflow: "visible" },
			}}
			data={[
				{
					label: (
						<Text size={compact ? "xs" : "sm"}>
							<Trans>Monthly billing</Trans>
						</Text>
					),
					value: "monthly",
				},
				{
					label: (
						<Group gap={6} wrap="nowrap" justify="center">
							<Text size={compact ? "xs" : "sm"}>
								<Trans>Annual billing</Trans>
							</Text>
							<Badge
								size="xs"
								variant="light"
								color="primary"
								styles={{
									label: { overflow: "visible", textOverflow: "clip" },
									root: {
										flex: "0 0 auto",
										overflow: "visible",
										textOverflow: "clip",
									},
								}}
							>
								<Trans>{MONTHLY_BILLING_PREMIUM_PCT}% off</Trans>
							</Badge>
						</Group>
					),
					value: "annual",
				},
			]}
			aria-label={t`Billing period`}
		/>
	);
}
