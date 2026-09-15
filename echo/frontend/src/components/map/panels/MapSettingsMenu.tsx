import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Checkbox,
	Divider,
	NumberInput,
	Popover,
	Radio,
	Stack,
	Text,
} from "@mantine/core";
import { GearSixIcon } from "@phosphor-icons/react";
import { attributeFor, COLOR_BY_OPTIONS } from "../attributes";
import type {
	BudgetAdjustment,
	BudgetResolution,
	MapBudgetBounds,
} from "../budgets";
import type { MapSettings } from "../state/settings";
import type { ColorBy } from "../types";

type MapSettingsMenuProps = {
	settings: MapSettings;
	onChange: (patch: Partial<MapSettings>) => void;
	/** The colour mode in effect, which the URL may set. */
	colorBy: ColorBy;
	onColorByChange: (colorBy: ColorBy) => void;
	/** The budgets in effect and every change made to the saved values. */
	budgets: BudgetResolution;
	bounds: MapBudgetBounds;
	/** Idle and error claims a check may start. */
	pendingClaimCount: number;
	onFactCheckAll: () => void;
	/** False for read-only roles: no fact-check controls. */
	canFactCheck: boolean;
};

const PANEL_TOGGLES: { key: keyof MapSettings; label: () => string }[] = [
	{ key: "showExplore", label: () => t`Explore` },
	{ key: "showShowcase", label: () => t`Showcase` },
	{ key: "showSpotlight", label: () => t`Spotlight` },
	{ key: "showTree", label: () => t`Tree` },
	{ key: "showClusters", label: () => t`Clusters` },
	{ key: "showLegend", label: () => t`Legend` },
];

/** Why a saved budget was not applied as saved. */
export const budgetAdjustmentLabel = (
	adjustment: BudgetAdjustment,
	nodeLimit: number,
): string => {
	const applied = adjustment.applied;
	const nodes = adjustment.field === "nodeLimit";
	switch (adjustment.reason) {
		case "invalid":
			return nodes
				? t`The node budget must be a whole number above zero, so ${applied} applies.`
				: t`The edge budget must be a whole number above zero, so ${applied} applies.`;
		case "ceiling":
			return nodes
				? t`This deployment shows up to ${applied} nodes.`
				: t`This deployment shows up to ${applied} edges.`;
		default:
			return t`Visible edges raised to ${applied} so the tree over ${nodeLimit} nodes fits.`;
	}
};

const readBudget = (value: string | number): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/** Panel visibility, colour mode, budgets, fact-check options and dark mode. */
export const MapSettingsMenu = ({
	settings,
	onChange,
	colorBy,
	onColorByChange,
	budgets,
	bounds,
	pendingClaimCount,
	onFactCheckAll,
	canFactCheck,
}: MapSettingsMenuProps) => {
	const applied = budgets.budgets;
	const defaultNodes = bounds.defaults.nodeLimit;
	const defaultEdges = bounds.defaults.edgeLimit;
	const hasCustomBudgets =
		settings.nodeLimit !== null || settings.edgeLimit !== null;

	return (
		<Popover position="bottom-end" shadow="xl" width={300} withinPortal>
			<Popover.Target>
				<ActionIcon
					variant="subtle"
					size="lg"
					aria-label={t`Panel settings`}
					title={t`Panel settings`}
				>
					<GearSixIcon size={20} />
				</ActionIcon>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="sm">
					<Text size="sm" fw={600}>
						<Trans>Panel settings</Trans>
					</Text>

					<Stack gap="xs">
						{PANEL_TOGGLES.map(({ key, label }) => (
							<Checkbox
								key={key}
								size="sm"
								label={label()}
								checked={Boolean(settings[key])}
								onChange={(event) =>
									onChange({ [key]: event.currentTarget.checked })
								}
							/>
						))}
						<Checkbox
							size="sm"
							label={t`Relationships`}
							checked={settings.showRelationships}
							onChange={(event) =>
								onChange({ showRelationships: event.currentTarget.checked })
							}
						/>
					</Stack>

					<Divider />

					<Radio.Group
						value={colorBy}
						onChange={(value) => onColorByChange(value as ColorBy)}
						label={
							<Text size="xs" className="uppercase tracking-widest">
								<Trans>Color nodes by</Trans>
							</Text>
						}
					>
						<Stack gap="xs" mt="xs">
							{COLOR_BY_OPTIONS.map((option) => (
								<Radio
									key={option}
									size="sm"
									value={option}
									label={attributeFor(option).label()}
								/>
							))}
						</Stack>
					</Radio.Group>

					{colorBy === "factCheck" && canFactCheck && (
						<>
							<Divider />
							<Checkbox
								size="sm"
								label={t`Auto fact-check new claims`}
								checked={settings.autoFactCheckClaims}
								onChange={(event) =>
									onChange({ autoFactCheckClaims: event.currentTarget.checked })
								}
							/>
							<Button
								size="sm"
								radius="xl"
								fullWidth
								disabled={pendingClaimCount === 0}
								onClick={onFactCheckAll}
							>
								{pendingClaimCount > 0 ? (
									<Trans>Fact check all ({pendingClaimCount})</Trans>
								) : (
									<Trans>Fact check all</Trans>
								)}
							</Button>
						</>
					)}

					<Divider />

					<Stack gap="xs">
						<Text size="xs" className="uppercase tracking-widest">
							<Trans>Map budget</Trans>
						</Text>
						<NumberInput
							size="xs"
							label={t`Nodes`}
							description={t`Default ${defaultNodes}`}
							min={1}
							step={1}
							allowDecimal={false}
							value={settings.nodeLimit ?? applied.nodeLimit}
							onChange={(value) => onChange({ nodeLimit: readBudget(value) })}
						/>
						<NumberInput
							size="xs"
							label={t`Visible edges`}
							description={t`Default ${defaultEdges}`}
							min={1}
							step={1}
							allowDecimal={false}
							value={settings.edgeLimit ?? applied.edgeLimit}
							onChange={(value) => onChange({ edgeLimit: readBudget(value) })}
						/>
						{budgets.adjustments.length > 0 && (
							<Stack gap={4} role="status">
								{budgets.adjustments.map((adjustment) => (
									<Text
										key={`${adjustment.field}-${adjustment.reason}`}
										size="xs"
									>
										{budgetAdjustmentLabel(adjustment, applied.nodeLimit)}
									</Text>
								))}
							</Stack>
						)}
						{hasCustomBudgets && (
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => onChange({ edgeLimit: null, nodeLimit: null })}
							>
								<Trans>Use the default budget</Trans>
							</Button>
						)}
					</Stack>

					<Divider />

					<Checkbox
						size="sm"
						label={t`Dark mode`}
						checked={settings.darkMode}
						onChange={(event) =>
							onChange({ darkMode: event.currentTarget.checked })
						}
					/>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
};
