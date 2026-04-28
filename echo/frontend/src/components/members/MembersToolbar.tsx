import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, SegmentedControl, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";

interface FilterSpec {
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
}

interface Props {
	search: string;
	onSearchChange: (value: string) => void;
	filter?: FilterSpec;
	searchPlaceholder?: string;
	count?: { shown: number; total: number };
	error?: string | null;
}

/**
 * Shared toolbar for Members surfaces (Team / Workspace / Project).
 *
 * Matches the pattern from the Team tab so the three scopes look the
 * same. Search width is constrained so the filter + count stay on the
 * right edge on wide screens and collapse beneath on narrow ones.
 */
export function MembersToolbar({
	search,
	onSearchChange,
	filter,
	searchPlaceholder,
	count,
	error,
}: Props) {
	return (
		<Group justify="space-between" align="center" wrap="wrap">
			<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 280 }}>
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={searchPlaceholder ?? t`Search name or email`}
					size="sm"
					value={search}
					onChange={(e) => onSearchChange(e.currentTarget.value)}
					style={{ flex: 1, maxWidth: 320 }}
				/>
				{filter && (
					<SegmentedControl
						size="xs"
						value={filter.value}
						onChange={filter.onChange}
						data={filter.options}
					/>
				)}
			</Group>
			{error ? (
				<Text size="xs" c="red">
					{error}
				</Text>
			) : count ? (
				<Text size="xs" c="dimmed">
					<Trans>
						Showing {count.shown} of {count.total}
					</Trans>
				</Text>
			) : null}
		</Group>
	);
}
