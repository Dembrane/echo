import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Divider,
	Group,
	Paper,
	Progress,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { usePricingConfigurator } from "@/components/pricing";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { FreeAllowanceBanner } from "@/components/workspace/FreeAllowanceBanner";
import {
	type FreeAllowance,
	type FreeMeter,
	useFreeAllowance,
} from "@/hooks/useFreeAllowance";
import { audioUsedUp, formatResetDay } from "@/lib/freeTier";
import { SELLABLE_TIER } from "@/lib/tiers";
import { formatDurationFromSeconds } from "@/lib/time";

type MeterKey = "audio_seconds" | "projects";

const labelOf = (key: MeterKey): string =>
	key === "audio_seconds" ? t`Audio` : t`Projects`;

const usageText = (key: MeterKey, meter: FreeMeter): string => {
	if (key === "audio_seconds") {
		// Under a minute left is used up, so only then does it read as the full amount.
		const shown = audioUsedUp(meter)
			? Math.max(meter.used, meter.limit)
			: meter.used;
		const used = formatDurationFromSeconds(shown);
		const limit = formatDurationFromSeconds(meter.limit);
		return t`${used} of ${limit}`;
	}
	const { used, limit } = meter;
	return t`${used} of ${limit}`;
};

function MeterRow({
	meterKey,
	meter,
	over,
	hint,
}: {
	meterKey: MeterKey;
	meter: FreeMeter;
	over: boolean;
	hint?: string;
}) {
	const pct =
		!over && meter.limit > 0
			? Math.min(100, (meter.used / meter.limit) * 100)
			: 100;
	return (
		<Stack gap="xs" data-testid={`free-allowance-${meterKey}`}>
			<Group justify="space-between">
				<Group gap="xs">
					<Text size="sm" c="dimmed">
						{labelOf(meterKey)}
					</Text>
					{hint && (
						<Text size="xs" c="dimmed" data-testid="free-allowance-hint">
							({hint})
						</Text>
					)}
				</Group>
				<Text size="sm" data-testid="free-allowance-value">
					{usageText(meterKey, meter)}
				</Text>
			</Group>
			<Progress
				value={pct}
				size="xs"
				color={over ? "red" : "primary"}
				aria-label={labelOf(meterKey)}
			/>
		</Stack>
	);
}

function AiMeterRow({ ai }: { ai: NonNullable<FreeAllowance["ai"]> }) {
	const percent = ai.exhausted ? 100 : Math.min(100, ai.percent_used);
	const label = t`AI this month`;
	return (
		<Stack gap="xs" data-testid="free-allowance-ai">
			<Group justify="space-between">
				<Text size="sm" c="dimmed">
					{label}
				</Text>
				<Text size="sm" data-testid="free-allowance-value">
					{t`${percent}% used`}
				</Text>
			</Group>
			<Progress
				value={percent}
				size="xs"
				color={ai.exhausted ? "red" : "primary"}
				aria-label={label}
			/>
		</Stack>
	);
}

// Free tier usage this month; renders nothing for paid accounts or on any error (403 included).
export function FreeAllowanceCard({ workspaceId }: { workspaceId: string }) {
	const { i18n } = useLingui();
	const { data } = useFreeAllowance(workspaceId);
	const configurator = usePricingConfigurator("free_allowance");

	if (!data?.free) return null;

	const audio = data.audio_seconds;
	const ai = data.ai && !data.ai.unlimited ? data.ai : null;
	// Projects is a standing cap (normally 1 of 1), so it never counts as full; the AI banner carries its own upgrade.
	const anyFull = !!audio && audioUsedUp(audio);
	// Audio and AI share the one reset, 00:00 UTC on the 1st.
	const resets = formatResetDay(data.resets_at, i18n.locale);

	return (
		<Paper p="lg" withBorder radius="sm" data-testid="free-allowance-card">
			<Stack gap="md">
				<Stack gap={4}>
					<Title order={5}>
						<Trans>Free plan allowance</Trans>
					</Title>
					<Text size="xs" c="dimmed">
						{data.scope === "workspace" ? (
							<Trans>Used by this workspace only</Trans>
						) : (
							<Trans>Shared across all workspaces in this organisation</Trans>
						)}
					</Text>
				</Stack>

				<FreeAllowanceBanner workspaceId={workspaceId} feature="ai" />

				{audio && (
					<MeterRow meterKey="audio_seconds" meter={audio} over={anyFull} />
				)}

				{ai && <AiMeterRow ai={ai} />}

				{resets && (
					<Text size="xs" c="dimmed" data-testid="free-allowance-resets">
						<Trans>Resets on {resets}</Trans>
					</Text>
				)}

				{data.projects && (
					<>
						<Divider />
						<MeterRow
							meterKey="projects"
							meter={data.projects}
							over={data.projects.used > data.projects.limit}
							hint={t`Not monthly`}
						/>
					</>
				)}

				{anyFull && (
					<Group>
						<Button
							size="xs"
							onClick={configurator.open}
							data-testid="free-allowance-upgrade"
						>
							<Trans>Tell us what you need</Trans>
						</Button>
					</Group>
				)}
			</Stack>
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
				currentTier="free"
				requiredTier={SELLABLE_TIER}
				canRequestUpgrade
				workspaceId={workspaceId}
				wallKey="free_allowance"
				entry="modal_direct"
			/>
		</Paper>
	);
}
