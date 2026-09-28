import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { formatDistanceToNowStrict } from "date-fns";

export interface MoveHistoryEntry {
	from?: string | null;
	from_label?: string | null;
	to?: string | null;
	to_label?: string | null;
	by?: string | null;
	by_label?: string | null;
	at?: string | null;
}

/**
 * Read-only audit list of where an entity (conversation / project) has been
 * moved and by whom. Reads the deliberately-redundant `move_history` log; each
 * entry already carries human-readable labels, so no id resolution is needed.
 * Renders nothing when there's no history.
 */
export function MoveHistory({
	entries,
	title,
}: {
	entries: MoveHistoryEntry[] | null | undefined;
	title: React.ReactNode;
}) {
	if (!Array.isArray(entries) || entries.length === 0) return null;

	// Newest first.
	const ordered = [...entries].reverse();

	return (
		<Stack gap={4}>
			<Text size="xs" fw={600}>
				{title}
			</Text>
			{ordered.map((e, i) => {
				const when = e.at
					? formatDistanceToNowStrict(new Date(e.at), { addSuffix: true })
					: null;
				const from = e.from_label || e.from || "—";
				const to = e.to_label || e.to || "—";
				const by = e.by_label || null;
				return (
					<Text key={`${e.at}-${i}`} size="xs">
						<Trans>
							{from} → {to}
						</Trans>
						{by ? (
							<>
								{" · "}
								<Trans>by {by}</Trans>
							</>
						) : null}
						{when ? ` · ${when}` : ""}
					</Text>
				);
			})}
		</Stack>
	);
}
