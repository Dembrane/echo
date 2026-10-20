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
import { formatDurationFromHours } from "@/lib/time";

type MeterKey = Exclude<
	keyof FreeAllowance,
	"free" | "period_start" | "resets_at"
>;

const MONTHLY_METERS: MeterKey[] = [
	"audio_seconds",
	"chats",
	"reports",
	"maps",
	"popcorn_sessions",
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
		case "popcorn_sessions":
			return t`Popcorn sessions`;
		case "projects":
			return t`Projects`;
	}
};

const usageText = (key: MeterKey, meter: FreeMeter): string => {
	if (key === "audio_seconds") {
		const used = formatDurationFromHours(meter.used / 3600);
		const limit = formatDurationFromHours(meter.limit / 3600);
		return t`${used} of ${limit}`;
	}
	const { used, limit } = meter;
	return t`${used} of ${limit}`;
};

const formatResets = (iso: string, locale: string): string => {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	});
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
		meter.limit > 0 ? Math.min(100, (meter.used / meter.limit) * 100) : 100;
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
	const anyFull = meters.some(({ meter }) => meter.used >= meter.limit);

	return (
		<Paper p="lg" withBorder radius="sm" data-testid="free-allowance-card">
			<Stack gap="md">
				<Stack gap={4}>
					<Title order={5}>
						<Trans>Free plan allowance</Trans>
					</Title>
					<Text size="xs" c="dimmed">
						<Trans>Shared across all workspaces in this organisation</Trans>
					</Text>
				</Stack>

				{meters.map(({ key, meter }) => (
					<MeterRow
						key={key}
						meterKey={key}
						meter={meter}
						over={meter.used >= meter.limit}
					/>
				))}

				{data.resets_at && (
					<Text size="xs" c="dimmed" data-testid="free-allowance-resets">
						<Trans>Resets on {formatResets(data.resets_at, i18n.locale)}</Trans>
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
				requiredTier={null}
				canRequestUpgrade
				workspaceId={workspaceId}
				wallKey="free_allowance"
				entry="modal_direct"
			/>
		</Paper>
	);
}
