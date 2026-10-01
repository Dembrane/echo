import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Paper, Progress, Stack, Text, Title } from "@mantine/core";
import { format } from "date-fns";
import type { PopcornDetail } from "@/components/popcorn/hooks";
import { testId } from "@/lib/testUtils";

// What the last read did and how far the second pass is: the numbers a host
// glances at before opening the wall.
export function PopcornStatus({ popcorn }: { popcorn: PopcornDetail }) {
	const counts = popcorn.counts;
	const loop = popcorn.loop;
	const phrases = counts.phrases;
	const validated = counts.validated ?? 0;
	const heldBack = counts.held_back ?? 0;
	const reading = counts.reading ?? 0;
	const started = loop?.last_run_started_at
		? new Date(loop.last_run_started_at)
		: null;
	const startedLabel =
		started && !Number.isNaN(started.getTime())
			? format(started, "EEE d MMM, HH:mm")
			: null;
	const detail = (loop?.last_run_detail ?? "").slice(0, 200);
	const validating = reading > 0 || (phrases > 0 && validated < phrases);

	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-status")}
		>
			<Stack gap="sm">
				<Title order={4}>
					<Trans>Status</Trans>
				</Title>
				{counts.conversations === 0 ? (
					<Text size="sm">
						<Trans>Waiting for the first conversation with a transcript.</Trans>
					</Text>
				) : (
					<Text size="sm" {...testId("popcorn-tally")}>
						{t`${counts.conversations} conversations · ${phrases} phrases · ${validated} validated`}
						{heldBack ? t` · ${heldBack} held back` : ""}
					</Text>
				)}
				{reading > 0 ? (
					<Text size="sm">
						{t`Reading ${reading} of ${counts.conversations} conversations…`}
					</Text>
				) : null}
				{validating && phrases > 0 ? (
					<Progress
						value={Math.round((validated / phrases) * 100)}
						size="sm"
						aria-label={t`Validation progress`}
						{...testId("popcorn-validation-progress")}
					/>
				) : null}
				{startedLabel ? (
					<Text size="xs" {...testId("popcorn-last-read")}>
						{t`Last read ${startedLabel}`}
						{loop?.last_run_status === "error" ? t` · failed` : ""}
					</Text>
				) : null}
				{detail ? (
					<Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
						{detail}
					</Text>
				) : null}
			</Stack>
		</Paper>
	);
}
