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
	ScrollArea,
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

const MAP_COLOR_BY_OPTIONS = COLOR_BY_OPTIONS.filter(
	(option) => option !== "type",
);

type MapSettingsMenuProps = {
	settings: MapSettings;
	onChange: (patch: Partial<MapSettings>) => void;
	/** The colour mode in effect, which the URL may set. */
	colorBy: ColorBy;
	onColorByChange: (colorBy: ColorBy) => void;
	/**
	 * The budgets in effect and every change made to the saved values. Left
	 * out where the server owns the budget (the presentation's room screen).
	 */
	budgets?: BudgetResolution;
	bounds?: MapBudgetBounds;
	/** Idle and error claims a check may start. */
	pendingClaimCount?: number;
	onFactCheckAll?: () => void;
	/** False for read-only roles: no fact-check controls. */
	canFactCheck: boolean;
	/** Controls this surface does not own, such as the room's dark switch. */
	hide?: ReadonlyArray<MapSettingsControl>;
	/**
	 * False keeps the menu inside the surface that opens it, so it follows that
	 * surface's colours and stays visible while the surface is fullscreen.
	 */
	withinPortal?: boolean;
	/** The map's conversations, in palette order; none where it can't filter. */
	conversations?: ReadonlyArray<MapConversation>;
	hiddenConversations?: ReadonlySet<string>;
	onHiddenConversationsChange?: (hidden: ReadonlySet<string>) => void;
	/** Tags on the map's conversations; none where the map has no tags to offer. */
	tags?: ReadonlyArray<MapConversation>;
	chosenTags?: ReadonlySet<string>;
	onChosenTagsChange?: (chosen: ReadonlySet<string>) => void;
};

export type MapConversation = { id: string; name: string; color: string };

const NO_CONVERSATIONS: ReadonlyArray<MapConversation> = [];
const NONE_HIDDEN: ReadonlySet<string> = new Set();

export type MapSettingsControl =
	| "showExplore"
	| "showRelationships"
	| "darkMode";

const PANEL_TOGGLES: { key: keyof MapSettings; label: () => string }[] = [
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

const NOTHING_HIDDEN: ReadonlyArray<MapSettingsControl> = [];

const readBudget = (value: string | number): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/** The host's own node and edge budget, over the deployment's bounds. */
const BudgetControls = ({
	settings,
	onChange,
	budgets,
	bounds,
}: Pick<MapSettingsMenuProps, "settings" | "onChange"> & {
	budgets: BudgetResolution;
	bounds: MapBudgetBounds;
}) => {
	const applied = budgets.budgets;
	const defaultNodes = bounds.defaults.nodeLimit;
	const defaultEdges = bounds.defaults.edgeLimit;
	const hasCustomBudgets =
		settings.nodeLimit !== null || settings.edgeLimit !== null;
	return (
		<Stack gap="xs">
			<Text size="xs">
				<Trans>Map budget</Trans>
			</Text>
			<NumberInput
				size="xs"
				label={t`Nodes`}
				description={t`Default ${defaultNodes}`}
				min={1}
				step={1}
				allowDecimal={false}
				radius={0}
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
				radius={0}
				value={settings.edgeLimit ?? applied.edgeLimit}
				onChange={(value) => onChange({ edgeLimit: readBudget(value) })}
			/>
			{budgets.adjustments.length > 0 && (
				<Stack gap={4} role="status">
					{budgets.adjustments.map((adjustment) => (
						<Text key={`${adjustment.field}-${adjustment.reason}`} size="xs">
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
	);
};

/** Panel visibility, colour mode, budgets, fact-check options and dark mode. */
export const MapSettingsMenu = ({
	settings,
	onChange,
	colorBy,
	onColorByChange,
	budgets,
	bounds,
	pendingClaimCount = 0,
	onFactCheckAll,
	canFactCheck,
	hide = NOTHING_HIDDEN,
	withinPortal = true,
	conversations = NO_CONVERSATIONS,
	hiddenConversations = NONE_HIDDEN,
	onHiddenConversationsChange,
	tags = NO_CONVERSATIONS,
	chosenTags = NONE_HIDDEN,
	onChosenTagsChange,
}: MapSettingsMenuProps) => {
	const toggleTag = (id: string, chosen: boolean) => {
		const next = new Set(chosenTags);
		if (chosen) next.add(id);
		else next.delete(id);
		onChosenTagsChange?.(next);
	};
	// Colouring by tag is offered only where there are tags to colour by.
	const colorOptions = MAP_COLOR_BY_OPTIONS.filter(
		(option) => option !== "tag" || tags.length > 0,
	);
	const toggleConversation = (id: string, shown: boolean) => {
		const next = new Set(hiddenConversations);
		if (shown) next.delete(id);
		else next.add(id);
		onHiddenConversationsChange?.(next);
	};
	return (
		<Popover
			position="bottom-end"
			shadow="xl"
			width={300}
			radius={0}
			withinPortal={withinPortal}
		>
			<Popover.Target>
				<ActionIcon
					variant="subtle"
					aria-label={t`Panel settings`}
					title={t`Panel settings`}
				>
					<GearSixIcon size={20} />
				</ActionIcon>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="sm">
					<Text size="sm">
						<Trans>Panel settings</Trans>
					</Text>

					<Stack gap="xs">
						{PANEL_TOGGLES.filter(
							({ key }) => !hide.includes(key as MapSettingsControl),
						).map(({ key, label }) => (
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
						{!hide.includes("showRelationships") && (
							<Checkbox
								size="sm"
								label={t`Relationships`}
								checked={settings.showRelationships}
								onChange={(event) =>
									onChange({ showRelationships: event.currentTarget.checked })
								}
							/>
						)}
					</Stack>

					<Divider />

					<Radio.Group
						value={colorBy}
						onChange={(value) => onColorByChange(value as ColorBy)}
						label={
							<Text size="xs">
								<Trans>Color nodes by</Trans>
							</Text>
						}
					>
						<Stack gap="xs" mt="xs">
							{colorOptions.map((option) => (
								<Radio
									key={option}
									size="sm"
									value={option}
									label={attributeFor(option).label()}
								/>
							))}
						</Stack>
					</Radio.Group>

					{onChosenTagsChange && tags.length > 0 && (
						<>
							<Divider />
							<Stack gap="xs">
								<Stack gap={4}>
									<Text size="xs">
										<Trans>Tags</Trans>
									</Text>
									<Text size="xs" c="dimmed">
										<Trans>
											Show only conversations with any of the ticked tags.
										</Trans>
									</Text>
								</Stack>
								<ScrollArea.Autosize mah={160} type="auto">
									<Stack gap="xs">
										{tags.map((tag) => (
											<Checkbox
												key={tag.id}
												size="sm"
												label={
													<span className="inline-flex items-center gap-2">
														<span
															aria-hidden="true"
															className="inline-block size-2 shrink-0 rounded-full"
															style={{ backgroundColor: tag.color }}
														/>
														{tag.name}
													</span>
												}
												checked={chosenTags.has(tag.id)}
												onChange={(event) =>
													toggleTag(tag.id, event.currentTarget.checked)
												}
											/>
										))}
									</Stack>
								</ScrollArea.Autosize>
							</Stack>
						</>
					)}

					{onHiddenConversationsChange && conversations.length > 1 && (
						<>
							<Divider />
							<Stack gap="xs">
								<Text size="xs">
									<Trans>Conversations</Trans>
								</Text>
								<ScrollArea.Autosize mah={200} type="auto">
									<Stack gap="xs">
										{conversations.map((conversation) => (
											<Checkbox
												key={conversation.id}
												size="sm"
												label={
													<span className="inline-flex items-center gap-2">
														<span
															aria-hidden="true"
															className="inline-block size-2 shrink-0 rounded-full"
															style={{ backgroundColor: conversation.color }}
														/>
														{conversation.name}
													</span>
												}
												checked={!hiddenConversations.has(conversation.id)}
												onChange={(event) =>
													toggleConversation(
														conversation.id,
														event.currentTarget.checked,
													)
												}
											/>
										))}
									</Stack>
								</ScrollArea.Autosize>
							</Stack>
						</>
					)}

					{colorBy === "factCheck" && canFactCheck && onFactCheckAll && (
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
								fullWidth
								disabled={pendingClaimCount === 0}
								onClick={onFactCheckAll}
							>
								{pendingClaimCount > 0 ? (
									<Trans>Fact-check all ({pendingClaimCount})</Trans>
								) : (
									<Trans>Fact-check all</Trans>
								)}
							</Button>
						</>
					)}

					{budgets && bounds && (
						<>
							<Divider />
							<BudgetControls
								settings={settings}
								onChange={onChange}
								budgets={budgets}
								bounds={bounds}
							/>
						</>
					)}

					{!hide.includes("darkMode") && (
						<>
							<Divider />

							<Checkbox
								size="sm"
								label={t`Dark mode`}
								checked={settings.darkMode}
								onChange={(event) =>
									onChange({ darkMode: event.currentTarget.checked })
								}
							/>
						</>
					)}
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
};
