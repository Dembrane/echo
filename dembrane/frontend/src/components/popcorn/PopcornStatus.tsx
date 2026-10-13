import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Paper, Progress, Stack, Text, Title } from "@mantine/core";
import { format } from "date-fns";
import { readAfterFinish } from "@/components/popcorn/finishedRead";
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
	const after = readAfterFinish(loop);
	const validating = reading > 0 || (phrases > 0 && validated < phrases);

	return (
		<Paper withBorder p="lg" {...testId("popcorn-status")}>
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
						{plural(counts.conversations, {
							one: "# conversation",
							other: "# conversations",
						})}
						{" · "}
						{plural(phrases, { one: "# phrase", other: "# phrases" })}
						{" · "}
						{t`${validated} validated`}
						{heldBack ? t` · ${heldBack} held back` : ""}
					</Text>
				)}
				{reading > 0 ? (
					<Text size="sm">
						{plural(counts.conversations, {
							one: `Reading ${reading} of # conversation…`,
							other: `Reading ${reading} of # conversations…`,
						})}
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
					<Text size="xs" c="dimmed" {...testId("popcorn-last-read")}>
						{t`Last read ${startedLabel}`}
						{loop?.last_run_status === "error" ? t` · failed` : ""}
					</Text>
				) : null}
				{after ? (
					<Text size="xs" c="dimmed" {...testId("popcorn-read-after-finish")}>
						{after}
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
