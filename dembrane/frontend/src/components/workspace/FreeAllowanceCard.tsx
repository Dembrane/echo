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
import {
	type FreeAllowance,
	type FreeMeter,
	useFreeAllowance,
} from "@/hooks/useFreeAllowance";
import { audioUsedUp, formatResetDate } from "@/lib/freeTier";
import { SELLABLE_TIER } from "@/lib/tiers";
import { formatDurationFromSeconds } from "@/lib/time";

type MeterKey = Exclude<
	keyof FreeAllowance,
	"free" | "scope" | "period_start" | "resets_at"
>;

const MONTHLY_METERS: MeterKey[] = [
	"audio_seconds",
	"chats",
	"reports",
	"maps",
	"popcorn_analyses",
];

const labelOf = (key: MeterKey): string => {
	switch (key) {
		case "audio_seconds":
			return t`Audio`;
		case "chats":
			return t`Chats`;
		case "reports":
			return t`Reports`;
		case "maps":
			return t`Maps`;
		case "popcorn_analyses":
			return t`Popcorn analyses`;
		case "projects":
			return t`Projects`;
	}
};

const isFull = (key: MeterKey, meter: FreeMeter): boolean =>
	key === "audio_seconds" ? audioUsedUp(meter) : meter.used >= meter.limit;

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

// Free tier usage this month; renders nothing for paid accounts or on any error (403 included).
export function FreeAllowanceCard({ workspaceId }: { workspaceId: string }) {
	const { i18n } = useLingui();
	const { data } = useFreeAllowance(workspaceId);
	const configurator = usePricingConfigurator("free_allowance");

	if (!data?.free) return null;

	const meters = MONTHLY_METERS.flatMap((key) => {
		const meter = data[key];
		return meter ? [{ key, meter }] : [];
	});
	// Projects is a standing cap (normally 1 of 1), so it never counts as full.
	const anyFull = meters.some(({ key, meter }) => isFull(key, meter));
	const resets = formatResetDate(data.resets_at, i18n.locale);

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

				{meters.map(({ key, meter }) => (
					<MeterRow
						key={key}
						meterKey={key}
						meter={meter}
						over={isFull(key, meter)}
					/>
				))}

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
