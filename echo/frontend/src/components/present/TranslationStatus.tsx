import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Loader,
	Progress,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { CheckCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { toast } from "@/components/common/Toaster";
import { languageOptionsByIso639_1 } from "@/components/language/LanguagePicker";
import { bff } from "@/lib/bff";
import { testId } from "@/lib/testUtils";
import type { TranslationStatus as Status } from "./hooks";

const languageName = (target: string | null | undefined) =>
	languageOptionsByIso639_1.find((option) => option.value === target)?.label ??
	target ??
	"";

/**
 * One line under the language controls: how much of the room's reading has
 * made it into the audience language. The server counts. When texts were left
 * over, Try again asks for those alone: no transcripts are read again.
 */
export function TranslationStatus({
	presentationId,
	status,
}: {
	presentationId?: string;
	status?: Status | null;
}) {
	const client = useQueryClient();
	const retry = useMutation({
		mutationFn: () =>
			bff.post(
				`/present/${encodeURIComponent(presentationId ?? "")}/translate`,
			),
		onError: () => toast.error(t`The translation could not be started`),
		// The job reports through the page's event stream; this read shows
		// "translating" straight away.
		onSuccess: () =>
			Promise.all([
				client.invalidateQueries({
					predicate: (query) => query.queryKey.includes("presentation"),
				}),
				client.invalidateQueries({
					queryKey: ["presentation-draft", presentationId],
				}),
			]),
	});
	if (!status || status.state === "off") return null;
	const total = Math.max(0, status.total ?? 0);
	const translated = Math.max(0, Math.min(status.translated ?? 0, total));
	const failed = Math.max(0, total - translated);
	const language = languageName(status.target);
	const percent = total ? Math.round((translated / total) * 100) : 0;
	// The counts above are the totals. With extra popcorn languages stacked on
	// the primary target they cover several languages at once, so each one gets
	// its own line underneath.
	const rows = status.targets ?? [];
	const breakdown =
		rows.length > 1 ? (
			<Stack gap={2} {...testId("present-translation-breakdown")}>
				{rows.map((row) => {
					const rowTotal = Math.max(0, row.total ?? 0);
					const rowDone = Math.max(0, Math.min(row.translated ?? 0, rowTotal));
					const name = languageName(row.target);
					return (
						<Text key={row.target} size="sm" c="dimmed">
							<Trans>
								{name}: {rowDone} of {rowTotal}
							</Trans>
						</Text>
					);
				})}
			</Stack>
		) : null;
	const withBreakdown = (line: ReactElement) =>
		breakdown ? (
			<Stack gap={4}>
				{line}
				{breakdown}
			</Stack>
		) : (
			line
		);

	if (status.state === "done")
		return withBreakdown(
			<Group gap="xs" wrap="nowrap" {...testId("present-translation-status")}>
				<CheckCircleIcon size={16} weight="fill" />
				<Text size="sm">
					<Trans>
						All {total} texts translated into {language}
					</Trans>
				</Text>
			</Group>,
		);

	if (status.state === "translating")
		return withBreakdown(
			<Stack gap={4} {...testId("present-translation-status")}>
				<Group gap="xs" wrap="nowrap">
					<Loader size="xs" aria-label={t`Translating`} />
					<Text size="sm">
						<Trans>
							Translating: {translated} of {total} into {language}
						</Trans>
					</Text>
				</Group>
				<Progress
					size="xs"
					value={percent}
					aria-label={t`Translation progress`}
				/>
			</Stack>,
		);

	return withBreakdown(
		<Group gap="xs" wrap="nowrap" {...testId("present-translation-status")}>
			<Tooltip label={status.detail} disabled={!status.detail}>
				<WarningIcon size={16} weight="fill" />
			</Tooltip>
			<Text size="sm">
				<Trans>
					{translated} of {total} translated, {failed} could not be translated
				</Trans>
			</Text>
			{presentationId && (
				<Button
					variant="subtle"
					size="compact-sm"
					loading={retry.isPending}
					onClick={() => retry.mutate()}
					{...testId("present-translation-retry-button")}
				>
					<Trans>Try again</Trans>
				</Button>
			)}
		</Group>,
	);
}
