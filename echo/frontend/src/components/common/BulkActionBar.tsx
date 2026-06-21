import { Plural } from "@lingui/react/macro";
import { Button, Checkbox, Group, Text } from "@mantine/core";
import { TrayArrowUp } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface BulkActionBarProps {
	/** Whether every current item is selected (header checkbox checked). */
	allSelected: boolean;
	/** Some but not all selected (header checkbox indeterminate). */
	someSelected: boolean;
	/** Toggle select-all (selects all current when partial, clears when all). */
	onToggleAll: () => void;
	selectedCount: number;
	/** Full-text label for the move action, e.g. "Move conversations". */
	moveLabel: ReactNode;
	onMove: () => void;
	"data-testid"?: string;
}

/**
 * Subtle row between a search bar and a list: a select-all checkbox on the
 * left, and the available bulk actions on the right that appear only once
 * something is selected. The only action for now is Move (tertiary button,
 * tray-arrow-up icon). Consistent across the conversations and projects
 * overviews.
 */
export function BulkActionBar({
	allSelected,
	someSelected,
	onToggleAll,
	selectedCount,
	moveLabel,
	onMove,
	"data-testid": dataTestId,
}: BulkActionBarProps) {
	return (
		<Group
			justify="space-between"
			align="center"
			px="xs"
			py={6}
			wrap="nowrap"
			style={{
				borderTop: "1px solid var(--mantine-color-default-border)",
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
			data-testid={dataTestId}
		>
			<Checkbox
				checked={allSelected}
				indeterminate={someSelected}
				onChange={onToggleAll}
				data-testid="bulk-select-all"
				label={
					selectedCount > 0 ? (
						<Text size="sm">
							<Plural
								value={selectedCount}
								one="# selected"
								other="# selected"
							/>
						</Text>
					) : undefined
				}
			/>
			{selectedCount > 0 && (
				<Button
					variant="subtle"
					size="xs"
					leftSection={<TrayArrowUp size={16} />}
					onClick={onMove}
					data-testid="bulk-move-button"
				>
					{moveLabel}
				</Button>
			)}
		</Group>
	);
}
