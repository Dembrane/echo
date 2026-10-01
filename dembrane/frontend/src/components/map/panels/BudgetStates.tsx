import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text } from "@mantine/core";
import type { MapBudgets } from "../budgets";

/** No arguments were found, even if other recipe outputs exist. */
export const EmptyArgumentsState = () => (
	<Stack gap="sm" className="max-w-2xl" id="map-empty-state">
		<Text>
			<Trans>No arguments were found in this project's conversations.</Trans>
		</Text>
	</Stack>
);

export type OverBudgetStateProps = {
	count: number;
	/** Budgets that admit the scope; null when a ceiling forbids it. */
	admit: MapBudgets | null;
	/** Highest count both deployment ceilings can admit, when bounded. */
	maximumCount: number | null;
	onRaise: (budgets: MapBudgets) => void;
};

/**
 * The argument scope is above its warning threshold. No layout starts and no
 * vectors load until the host admits this exact result for the page session.
 */
export const OverBudgetState = ({
	count,
	admit,
	maximumCount,
	onRaise,
}: OverBudgetStateProps) => {
	return (
		<Stack gap="md" className="max-w-2xl" id="map-over-budget">
			<Stack gap={4}>
				<Text>
					<Trans>
						This map has {count} arguments. Rendering it may be demanding on
						your device.
					</Trans>
				</Text>
				<Text size="sm">
					<Trans>The map loads after you choose to open it.</Trans>
				</Text>
			</Stack>

			<Group gap="sm">
				<Button disabled={!admit} onClick={() => admit && onRaise(admit)}>
					<Trans>Open map</Trans>
				</Button>
			</Group>
			{!admit && maximumCount !== null && (
				<Text size="xs">
					<Trans>
						This deployment can open maps with up to {maximumCount} arguments.
					</Trans>
				</Text>
			)}
		</Stack>
	);
};
