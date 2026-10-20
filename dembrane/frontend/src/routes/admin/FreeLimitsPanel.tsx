import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	NumberInput,
	Paper,
	Skeleton,
	Stack,
	Table,
	Text,
	Title,
} from "@mantine/core";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import {
	type FreeLimit,
	type FreeLimitKey,
	useFreeLimits,
	useSetFreeLimit,
} from "@/hooks/useFreeLimits";

const MAX_STORED = 10_000_000;

type Unit = "hours" | "minutes" | "count";

const unitOf = (key: FreeLimitKey): Unit =>
	key.startsWith("audio_seconds_")
		? "hours"
		: key.startsWith("popcorn_") && key.endsWith("_minutes")
			? "minutes"
			: "count";

// Stored value (seconds or count) to the unit staff edit in.
const toDisplay = (key: FreeLimitKey, stored: number): number =>
	unitOf(key) === "hours" ? Math.round((stored / 3600) * 100) / 100 : stored;

const toStored = (key: FreeLimitKey, display: number): number =>
	unitOf(key) === "hours" ? Math.round(display * 3600) : Math.round(display);

const formatValue = (key: FreeLimitKey, stored: number): string => {
	const n = toDisplay(key, stored);
	const unit = unitOf(key);
	if (unit === "hours") return t`${n} h`;
	if (unit === "minutes") return t`${n} min`;
	return String(n);
};

const labelOf = (key: FreeLimitKey): string => {
	switch (key) {
		case "audio_seconds_month":
			return t`Audio per month`;
		case "audio_seconds_conversation":
			return t`Audio per conversation`;
		case "projects":
			return t`Projects`;
		case "chats_month":
			return t`Chats per month`;
		case "chat_turns_per_chat":
			return t`Turns per chat`;
		case "reports_month":
			return t`Reports per month`;
		case "maps_month":
			return t`Maps per month`;
		case "popcorn_analyses_month":
			return t`Popcorn analyses per month`;
		case "popcorn_cadence_minutes":
			return t`Popcorn cadence floor`;
	}
};

const formatWhen = (iso: string, locale: string): string => {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(locale, {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
		year: "numeric",
	});
};

function FreeLimitRow({ limit }: { limit: FreeLimit }) {
	const { i18n } = useLingui();
	const mutation = useSetFreeLimit();
	const unit = unitOf(limit.key);
	const current = toDisplay(limit.key, limit.value);
	const [draft, setDraft] = useState<string | number>(current);
	const [seen, setSeen] = useState(limit.value);
	// A saved or refetched value replaces the draft.
	if (seen !== limit.value) {
		setSeen(limit.value);
		setDraft(current);
	}

	const draftNumber = typeof draft === "number" ? draft : Number.NaN;
	const nextStored = Number.isFinite(draftNumber)
		? toStored(limit.key, draftNumber)
		: null;
	const canSave =
		nextStored !== null &&
		nextStored >= 0 &&
		nextStored <= MAX_STORED &&
		nextStored !== limit.value;

	const save = () => {
		if (nextStored === null) return;
		mutation.mutate(
			{ key: limit.key, value: nextStored },
			{ onSuccess: () => toast.success(t`Limit saved`) },
		);
	};

	return (
		<Table.Tr data-testid={`free-limit-row-${limit.key}`}>
			<Table.Td>
				<Text size="sm">{labelOf(limit.key)}</Text>
			</Table.Td>
			<Table.Td>
				<Text size="sm" data-testid="free-limit-current">
					{formatValue(limit.key, limit.value)}
				</Text>
			</Table.Td>
			<Table.Td>
				<Text size="sm" c="dimmed">
					{formatValue(limit.key, limit.default)}
				</Text>
			</Table.Td>
			<Table.Td>
				{limit.updated_at ? (
					<Stack gap={0}>
						<Text size="xs" ff="monospace">
							{limit.updated_by ?? ""}
						</Text>
						<Text size="xs" c="dimmed">
							{formatWhen(limit.updated_at, i18n.locale)}
						</Text>
					</Stack>
				) : (
					<Text size="xs" c="dimmed">
						<Trans>Never changed</Trans>
					</Text>
				)}
			</Table.Td>
			<Table.Td>
				<Stack gap="xs">
					<Group gap="xs" wrap="nowrap">
						<NumberInput
							size="xs"
							w={110}
							min={0}
							max={unit === "hours" ? MAX_STORED / 3600 : MAX_STORED}
							allowNegative={false}
							allowDecimal={unit === "hours"}
							decimalScale={unit === "hours" ? 2 : 0}
							value={draft}
							onChange={setDraft}
							aria-label={labelOf(limit.key)}
							rightSection={
								unit === "count" ? undefined : (
									<Text size="xs" c="dimmed">
										{unit === "hours" ? t`h` : t`min`}
									</Text>
								)
							}
						/>
						<Button
							size="xs"
							disabled={!canSave}
							loading={mutation.isPending}
							onClick={save}
						>
							<Trans>Save</Trans>
						</Button>
					</Group>
					{mutation.isError && <ErrorNotice error={mutation.error} />}
				</Stack>
			</Table.Td>
		</Table.Tr>
	);
}

export function FreeLimitsPanel() {
	const { data, error, isLoading, refetch } = useFreeLimits();

	return (
		<Stack gap="sm">
			<Title order={4}>
				<Trans>Free plan limits</Trans>
			</Title>
			<Text size="xs" c="dimmed">
				<Trans>
					These limits apply to every free account. Changes take effect within
					about a minute.
				</Trans>
			</Text>
			{isLoading ? (
				<Skeleton h={320} />
			) : !data ? (
				<ErrorNotice
					error={error ?? new Error("free limits unavailable")}
					onRetry={() => void refetch()}
					title={t`Could not load the free plan limits.`}
				/>
			) : (
				<Paper withBorder style={{ overflowX: "auto" }}>
					<Table verticalSpacing="xs" fz="sm">
						<Table.Thead>
							<Table.Tr>
								<Table.Th>
									<Trans>Limit</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Current</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Default</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>Changed by</Trans>
								</Table.Th>
								<Table.Th>
									<Trans>New value</Trans>
								</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{data.map((limit) => (
								<FreeLimitRow key={limit.key} limit={limit} />
							))}
						</Table.Tbody>
					</Table>
				</Paper>
			)}
		</Stack>
	);
}
