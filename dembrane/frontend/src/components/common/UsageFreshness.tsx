import { t } from "@lingui/core/macro";
import { Anchor, Text } from "@mantine/core";
import { formatRelativeAgo } from "@/lib/time";

interface Props {
	dataUpdatedAt: number | undefined | null;
	refreshing: boolean;
	onRefresh: () => void;
}

/**
 * "Updated X ago · Refresh" line used at the bottom of every usage
 * surface. One component for one pattern — so when we change the
 * wording or styling we change it in one place.
 *
 * Render as a plain text line with an inline anchor — no button
 * chrome, no icons. Keeps the focus on the usage numbers; the
 * refresh is there when you need it, not competing for attention.
 */
export function UsageFreshness({ dataUpdatedAt, refreshing, onRefresh }: Props) {
	return (
		<Text size="xs" c="dimmed">
			{t`Updated ${formatRelativeAgo(dataUpdatedAt ?? undefined)} · `}
			<Anchor
				component="button"
				type="button"
				size="xs"
				onClick={onRefresh}
				c="dimmed"
				style={{ textDecoration: "underline" }}
			>
				{refreshing ? t`Refreshing…` : t`Refresh`}
			</Anchor>
		</Text>
	);
}
