import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { MapBudgets } from "../budgets";

/** No object to show: none saved, no type chosen, or none of the chosen types. */
export const EmptyObjectsState = ({
	totalCount,
	selectedCount,
	children,
}: {
	/** Saved objects of every type in this scope. */
	totalCount: number;
	selectedCount: number;
	/** Actions, such as generating a map. */
	children?: ReactNode;
}) => (
	<Stack gap="sm" className="max-w-2xl" id="map-empty-state">
		<Text>
			{totalCount === 0 ? (
				<Trans>There are no saved objects in this scope yet.</Trans>
			) : selectedCount === 0 ? (
				<Trans>Choose which objects to show in the Objects filter.</Trans>
			) : (
				<Trans>
					The chosen object types have no saved objects. Choose other types or
					generate them.
				</Trans>
			)}
		</Text>
		{children}
	</Stack>
);

export type OverBudgetStateProps = {
	count: number;
	budgets: MapBudgets;
	/** Budgets that admit the scope; null when a ceiling forbids it. */
	admit: MapBudgets | null;
	/** The deployment's node ceiling, when there is one. */
	maxNodes: number | null;
	onRaise: (budgets: MapBudgets) => void;
	/** The Objects filter, inline, so narrowing the types is one step away. */
	filter: ReactNode;
	/** Arguments are most of the scope. */
	argumentsDominate: boolean;
	onDeduplicate?: () => void;
	onNarrowScope?: () => void;
};

/**
 * The scope has more objects than the node budget. No layout starts and no
 * vectors load; the host raises the budget, filters, narrows the source or
 * deduplicates.
 */
export const OverBudgetState = ({
	count,
	budgets,
	admit,
	maxNodes,
	onRaise,
	filter,
	argumentsDominate,
	onDeduplicate,
	onNarrowScope,
}: OverBudgetStateProps) => {
	const nodeLimit = budgets.nodeLimit;
	return (
		<Stack gap="md" className="max-w-2xl" id="map-over-budget">
			<Stack gap={4}>
				<Text>
					<Trans>
						This scope has {count} objects. The map shows up to {nodeLimit} at
						once.
					</Trans>
				</Text>
				<Text size="sm">
					<Trans>
						The map and its vectors load once the scope fits the budget.
					</Trans>
				</Text>
			</Stack>

			<Group gap="sm">
				<Button disabled={!admit} onClick={() => admit && onRaise(admit)}>
					<Trans>Raise the budget to {count}</Trans>
				</Button>
				{argumentsDominate && onDeduplicate && (
					<Button variant="outline" onClick={onDeduplicate}>
						<Trans>Deduplicate arguments</Trans>
					</Button>
				)}
				{onNarrowScope && (
					<Button variant="subtle" onClick={onNarrowScope}>
						<Trans>Narrow the source</Trans>
					</Button>
				)}
			</Group>
			{!admit && maxNodes !== null && (
				<Text size="xs">
					<Trans>This deployment shows up to {maxNodes} nodes.</Trans>
				</Text>
			)}

			<Stack gap="xs">
				<Text size="xs" className="uppercase tracking-widest">
					<Trans>Filter the objects</Trans>
				</Text>
				{filter}
			</Stack>
		</Stack>
	);
};
