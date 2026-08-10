import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Card,
	Collapse,
	Divider,
	Group,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	BatteryLowIcon,
	BroadcastIcon,
	CaretRightIcon,
	MicrophoneIcon,
	WarningCircleIcon,
	WifiSlashIcon,
} from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import {
	type MonitorConversation,
	useConversationMonitor,
} from "@/hooks/useConversationMonitor";
import { useWorkspace } from "@/hooks/useWorkspace";
import { SELLABLE_TIER, type Tier } from "@/lib/tiers";
import { ConversationDrilldownModal } from "./ConversationDrilldownModal";
import { MonitorBadge } from "./MonitorBadge";
import {
	type MonitorStatusGroup,
	monitorStatusGroup,
	type SettledStatus,
	settleStatusGroups,
	STATUS_GROUP_ORDER,
	statusGroupLabel,
} from "./monitorGrouping";
import { StatePill, stateColor } from "./StatePill";

// How many tiles to render per group before collapsing the rest behind a
// "show more" — keeps the page calm and bounded even for a busy group.
const MAX_ROWS_PER_GROUP = 25;

/** The dimension the host groups the grid by. */
type GroupBy = "tag" | "status";

// How often the settle clock is re-evaluated while grouping by status.
const SETTLE_TICK_MS = 1000;

// Stable keys for the meter segments (index drives the fill).
const METER_SEGMENTS = ["s1", "s2", "s3", "s4", "s5"];
// Voice RMS sits in this low band (nowhere near 1.0); normalize it to the full
// meter so the bars use their whole range.
const MIC_LEVEL_FLOOR = 0.03;
const MIC_LEVEL_CEILING = 0.3;

/** Mic-level meter. Mic glyph + equal-height segments read as loudness, not
 * signal strength. */
const AudioLevelMeter = ({ level }: { level: number }) => {
	const scaled = Math.min(
		1,
		Math.max(
			0,
			(level - MIC_LEVEL_FLOOR) / (MIC_LEVEL_CEILING - MIC_LEVEL_FLOOR),
		),
	);
	const active = Math.round(scaled * METER_SEGMENTS.length);
	return (
		<Tooltip
			label={
				active > 0
					? t`Audio is coming in`
					: t`Very quiet right now. Check the mic isn't muted.`
			}
			withArrow
		>
			<Group gap={3} align="center" wrap="nowrap" aria-hidden>
				<MicrophoneIcon size={13} />
				<Group gap={2} align="center" wrap="nowrap">
					{METER_SEGMENTS.map((id, i) => (
						<Box
							key={id}
							style={{
								backgroundColor:
									i < active
										? "var(--mantine-color-green-6)"
										: "var(--mantine-color-gray-3)",
								borderRadius: 1,
								height: 10,
								width: 3,
							}}
						/>
					))}
				</Group>
			</Group>
		</Tooltip>
	);
};

const isWeakNetwork = (conversation: MonitorConversation): boolean => {
	const network = conversation.network;
	if (!network) return false;
	if (network.online === false) return true;
	const type = network.effective_type;
	return type === "2g" || type === "slow-2g";
};

const isLowBattery = (conversation: MonitorConversation): boolean => {
	const battery = conversation.battery;
	if (!battery || battery.charging) return false;
	return typeof battery.level === "number" && battery.level <= 0.15;
};

const formatClock = (totalSeconds: number): string => {
	const s = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor((s % 3600) / 60);
	const seconds = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(minutes)}:${pad(seconds)}`
		: `${minutes}:${pad(seconds)}`;
};

// Recorded length only: server recorded_seconds (ticks while recording, frozen
// when paused) or the final duration once finished. Never a wall-clock guess.
const LiveDuration = ({
	conversation,
}: {
	conversation: MonitorConversation;
}) => {
	const recording =
		conversation.state === "recording" &&
		conversation.is_live &&
		!conversation.is_finished;
	const serverSeconds = conversation.recorded_seconds;

	// Local seconds accrued on top of the last server value while recording.
	const [extra, setExtra] = useState(0);
	// Reset the offset during render (not in an effect) when the server value or
	// recording state changes, so the corrected time never paints a stale frame.
	const [anchor, setAnchor] = useState({ recording, serverSeconds });
	if (
		anchor.serverSeconds !== serverSeconds ||
		anchor.recording !== recording
	) {
		setAnchor({ recording, serverSeconds });
		setExtra(0);
	}
	useEffect(() => {
		if (!recording) return;
		const id = setInterval(() => setExtra((value) => value + 1), 1000);
		return () => clearInterval(id);
	}, [recording]);

	let label: string | null = null;
	if (conversation.is_finished) {
		// Final server duration is authoritative once finished.
		if (
			typeof conversation.duration === "number" &&
			conversation.duration > 0
		) {
			label = formatClock(conversation.duration);
		} else if (typeof serverSeconds === "number") {
			label = formatClock(serverSeconds);
		}
	} else if (typeof serverSeconds === "number") {
		label = formatClock(serverSeconds + (recording ? extra : 0));
	}
	if (!label) return null;
	// State-colored dot (same colors as the StatePill) + graphite tabular clock.
	const dotColor = stateColor(conversation.state);
	return (
		<Group gap={4} align="center" wrap="nowrap">
			<span
				aria-hidden
				className="inline-block h-1.5 w-1.5 rounded-full"
				style={{ backgroundColor: `var(--mantine-color-${dotColor}-6)` }}
			/>
			<Text size="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
				{label}
			</Text>
		</Group>
	);
};

// A deliberately vague, conservative "time to finish the transcription
// backlog", bucketed and rounded up so we never over-promise.
const catchUpLabel = (seconds: number): string | null => {
	if (!seconds || seconds <= 0) return null;
	const minutes = Math.ceil(seconds / 60);
	const bucket = [1, 2, 5, 10, 15, 20, 30].find((value) => value >= minutes);
	return bucket ? `~${bucket} min` : "~30+ min";
};

/** One grid tile. The grid is the only view, so this is a compact square: state
 * pill, name, recorded time, and the handful of at-a-glance warnings. Anything
 * deeper lives one click away in the drilldown modal. */
const MonitorTile = ({
	conversation,
	highlighted,
	onLockedClick,
	onEdit,
}: {
	conversation: MonitorConversation;
	highlighted?: boolean;
	onLockedClick?: () => void;
	onEdit?: () => void;
}) => {
	const label = conversation.label?.trim() || t`Anonymous participant`;
	const weakNetwork = isWeakNetwork(conversation);
	const lowBattery = isLowBattery(conversation);
	const isLocked = conversation.locked;
	// Locked tiles open the upgrade modal; unlocked tiles open the edit modal.
	const clickable = isLocked || !!onEdit;

	const card = (
		<Card
			withBorder
			p="xs"
			radius="sm"
			className={`transition-colors h-full ${clickable ? "hover:!border-primary-400 cursor-pointer" : ""} ${highlighted ? "!border-primary-500 ring-2 ring-primary-200" : ""}`}
		>
			<Stack
				gap={6}
				justify="space-between"
				style={{ height: "100%", minWidth: 0 }}
			>
				<Group justify="space-between" align="center" wrap="nowrap" gap={4}>
					<StatePill state={conversation.state} />
					<Group gap={4} align="center" wrap="nowrap">
						{conversation.recording_health === "receiving" &&
							typeof conversation.audio_level === "number" && (
								<AudioLevelMeter level={conversation.audio_level} />
							)}
						{conversation.recording_health === "stalled" && (
							<Tooltip
								label={t`Audio was coming in but stopped. They may have lost connection or locked their phone.`}
								multiline
								maw={280}
								withArrow
							>
								<span>
									<WarningCircleIcon size={14} className="text-orange-500" />
								</span>
							</Tooltip>
						)}
						{conversation.recording_health === "backgrounded" && (
							<Tooltip
								label={t`Their screen is locked or the tab is hidden. Recording pauses until they come back.`}
								multiline
								maw={280}
								withArrow
							>
								<Text span size="xs" fw={600}>
									{t`Away`}
								</Text>
							</Tooltip>
						)}
						{conversation.has_error && (
							<Tooltip label={t`Error`} withArrow>
								<span>
									<WarningCircleIcon
										size={14}
										className="text-red-500 animate-pulse"
									/>
								</span>
							</Tooltip>
						)}
					</Group>
				</Group>

				<Text size="sm" fw={600} truncate title={label}>
					{label}
				</Text>

				<Group justify="space-between" align="center" wrap="nowrap" gap={4}>
					<LiveDuration conversation={conversation} />
					<Group gap={4} align="center" wrap="nowrap">
						{weakNetwork && (
							<Tooltip label={t`Weak network`} withArrow>
								<WifiSlashIcon size={14} className="text-orange-500" />
							</Tooltip>
						)}
						{lowBattery && (
							<Tooltip label={t`Low battery`} withArrow>
								<BatteryLowIcon size={14} className="text-orange-500" />
							</Tooltip>
						)}
					</Group>
				</Group>
			</Stack>
		</Card>
	);

	// The wrapper is the grid item, so it must carry the height for the card's
	// h-full to resolve against, else the squares come out ragged.

	// Locked tiles open the upgrade modal instead of the (also-gated) detail view.
	if (isLocked) {
		return (
			<Box
				role="button"
				tabIndex={0}
				className="block h-full"
				aria-label={t`Locked conversation, upgrade to view`}
				onClick={onLockedClick}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onLockedClick?.();
					}
				}}
			>
				{card}
			</Box>
		);
	}

	if (!onEdit) return card;
	return (
		<Box
			role="button"
			tabIndex={0}
			className="block h-full"
			aria-label={t`Open ${label}`}
			onClick={onEdit}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onEdit();
				}
			}}
		>
			{card}
		</Box>
	);
};

const UNTAGGED = "__untagged__";

type MonitorGroup = {
	key: string;
	label: string;
	items: MonitorConversation[];
	liveCount: number;
};

// created_at as epoch ms for sorting; missing/invalid sinks to the end.
const createdAtMs = (conversation: MonitorConversation): number => {
	if (!conversation.created_at) return Number.POSITIVE_INFINITY;
	const ms = new Date(conversation.created_at).getTime();
	return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

// Tiles are always ordered by created_at, never by anything that changes live,
// so a tile holds its place inside its group as its state changes.
const sortItems = (items: MonitorConversation[]): MonitorConversation[] =>
	[...items].sort((a, b) => createdAtMs(a) - createdAtMs(b));

const groupByTag = (conversations: MonitorConversation[]): MonitorGroup[] => {
	const groups = new Map<string, MonitorGroup>();
	const order: string[] = [];
	for (const conversation of conversations) {
		// A conversation lives under its first tag (or an Untagged bucket), so
		// each tile appears once. Grouping keeps a busy project scannable.
		const tag = conversation.tags[0]?.trim() || UNTAGGED;
		let group = groups.get(tag);
		if (!group) {
			group = {
				items: [],
				key: tag,
				label: tag === UNTAGGED ? t`Untagged` : tag,
				liveCount: 0,
			};
			groups.set(tag, group);
			order.push(tag);
		}
		group.items.push(conversation);
		if (conversation.is_live) group.liveCount += 1;
	}
	for (const group of groups.values()) {
		group.items = sortItems(group.items);
	}
	// Group order by first-seen; Untagged sinks to the end.
	const firstSeen = (group: MonitorGroup): number =>
		group.items.length ? createdAtMs(group.items[0]) : Number.POSITIVE_INFINITY;
	return order
		.map((tag) => groups.get(tag) as MonitorGroup)
		.sort((a, b) => {
			if ((a.key === UNTAGGED) !== (b.key === UNTAGGED)) {
				return a.key === UNTAGGED ? 1 : -1;
			}
			return firstSeen(a) - firstSeen(b);
		});
};

/** Group by status, using the settled status per conversation so a one-second
 * blip doesn't throw a tile across the page. Section order is the fixed
 * STATUS_GROUP_ORDER, never count-driven, so the sections themselves never
 * reshuffle underneath the host. */
export const groupByStatus = (
	conversations: MonitorConversation[],
	statusOf: (conversation: MonitorConversation) => MonitorStatusGroup,
): MonitorGroup[] => {
	const buckets = new Map<MonitorStatusGroup, MonitorConversation[]>();
	for (const conversation of conversations) {
		const status = statusOf(conversation);
		const bucket = buckets.get(status);
		if (bucket) bucket.push(conversation);
		else buckets.set(status, [conversation]);
	}
	return STATUS_GROUP_ORDER.filter((status) => buckets.get(status)?.length).map(
		(status) => {
			const items = sortItems(buckets.get(status) ?? []);
			return {
				items,
				key: status,
				label: statusGroupLabel(status),
				liveCount: items.filter((conversation) => conversation.is_live).length,
			};
		},
	);
};

/** True when two id -> group maps would render identically. */
const sameGroups = (
	a: ReadonlyMap<string, MonitorStatusGroup>,
	b: ReadonlyMap<string, MonitorStatusGroup>,
): boolean => {
	if (a.size !== b.size) return false;
	for (const [id, group] of a) if (b.get(id) !== group) return false;
	return true;
};

/** Committed status per conversation. The settle clock lives in a ref, so only
 * a status that actually changes group triggers a re-render. */
const useSettledStatuses = (
	conversations: MonitorConversation[],
	enabled: boolean,
): ReadonlyMap<string, MonitorStatusGroup> => {
	const settledRef = useRef<Map<string, SettledStatus>>(new Map());
	const conversationsRef = useRef(conversations);
	const [groups, setGroups] = useState<ReadonlyMap<string, MonitorStatusGroup>>(
		new Map(),
	);

	const tick = useCallback(() => {
		settledRef.current = settleStatusGroups(
			settledRef.current,
			conversationsRef.current,
			Date.now(),
		);
		const next = new Map<string, MonitorStatusGroup>();
		for (const [id, settled] of settledRef.current) next.set(id, settled.group);
		setGroups((previous) => (sameGroups(previous, next) ? previous : next));
	}, []);

	// Re-settle as soon as a new snapshot lands.
	useEffect(() => {
		conversationsRef.current = conversations;
		if (enabled) tick();
	}, [conversations, enabled, tick]);

	// A slow clock so a pending change still matures when the snapshot stream
	// goes quiet. Kept separate from the snapshot effect so a busy stream can't
	// restart the interval faster than it fires.
	useEffect(() => {
		if (!enabled) return;
		const id = setInterval(tick, SETTLE_TICK_MS);
		return () => clearInterval(id);
	}, [enabled, tick]);

	return groups;
};

const MonitorGroupSection = ({
	group,
	highlightedConversationId,
	onLockedClick,
	onEdit,
}: {
	group: MonitorGroup;
	highlightedConversationId?: string | null;
	onLockedClick?: (conversation: MonitorConversation) => void;
	onEdit?: (conversation: MonitorConversation) => void;
}) => {
	const [opened, { toggle }] = useDisclosure(true);
	const [expanded, setExpanded] = useState(false);
	const visible = expanded
		? group.items
		: group.items.slice(0, MAX_ROWS_PER_GROUP);
	const overflow = group.items.length - visible.length;

	return (
		<Stack gap="xs">
			<Group
				gap="xs"
				align="center"
				className="cursor-pointer select-none"
				role="button"
				tabIndex={0}
				aria-expanded={opened}
				onClick={toggle}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						if (event.key === " ") event.preventDefault();
						toggle();
					}
				}}
			>
				<ActionIcon variant="subtle" color="gray" size="sm" aria-hidden>
					<CaretRightIcon
						size={14}
						style={{
							transform: opened ? "rotate(90deg)" : "none",
							transition: "transform 150ms ease",
						}}
					/>
				</ActionIcon>
				<Text size="xs" fw={600} tt="uppercase">
					{group.label}
				</Text>
				<Text size="xs">{group.items.length}</Text>
				{group.liveCount > 0 && (
					<MonitorBadge size="xs" color="gray" variant="outline">
						<Plural value={group.liveCount} one="# live" other="# live" />
					</MonitorBadge>
				)}
			</Group>
			<Collapse in={opened}>
				<Stack gap="xs">
					<SimpleGrid
						cols={{ base: 2, sm: 3, md: 4, lg: 5, xl: 6 }}
						spacing="xs"
					>
						{visible.map((conversation) => (
							<MonitorTile
								key={conversation.id}
								conversation={conversation}
								highlighted={conversation.id === highlightedConversationId}
								onLockedClick={() => onLockedClick?.(conversation)}
								onEdit={onEdit ? () => onEdit(conversation) : undefined}
							/>
						))}
					</SimpleGrid>
					{overflow > 0 && (
						<Text
							size="xs"
							role="button"
							tabIndex={0}
							className="cursor-pointer select-none pl-1 hover:underline"
							onClick={() => setExpanded(true)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									if (event.key === " ") event.preventDefault();
									setExpanded(true);
								}
							}}
						>
							<Trans>Show {overflow} more</Trans>
						</Text>
					)}
				</Stack>
			</Collapse>
		</Stack>
	);
};

export const LiveMonitorSection = ({
	projectId,
	standalone = false,
	highlightedConversationId,
	hideHeader = false,
}: {
	projectId: string;
	/** On the dedicated Monitor page, show an empty state instead of
	 * collapsing to nothing when there is no recent activity. */
	standalone?: boolean;
	/** Tile to highlight (hovered from the funnel above). */
	highlightedConversationId?: string | null;
	/** Suppress the internal "Live monitoring" header + chips (when embedded
	 * under a shared section header, e.g. the project home). */
	hideHeader?: boolean;
}) => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const { workspace } = useWorkspace();
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	// Drilldown selection by id, so the open modal keeps reading fresh snapshots
	// (and closes on its own once the tile is deleted / ages out).
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const [groupBy, setGroupBy] = useState<GroupBy>("tag");

	const { conversations, summary, isLoading, error, isStreaming } =
		useConversationMonitor(projectId);

	const settledStatuses = useSettledStatuses(
		conversations,
		groupBy === "status",
	);

	const groups = useMemo(() => {
		if (groupBy === "tag") return groupByTag(conversations);
		return groupByStatus(
			conversations,
			// Fall back to the raw status for a conversation the settle clock has
			// not seen yet (first frame after it appears).
			(conversation) =>
				settledStatuses.get(conversation.id) ??
				monitorStatusGroup(conversation),
		);
	}, [conversations, groupBy, settledStatuses]);

	const selected =
		conversations.find((conversation) => conversation.id === selectedId) ??
		null;
	// Tiles link to the conversation detail page when we know the workspace.
	const base =
		workspaceId && projectId ? `/w/${workspaceId}/projects/${projectId}` : null;

	const handleGroupByChange = (value: string) => {
		if (value !== "tag" && value !== "status") return;
		setGroupBy(value);
		posthog.capture("monitor_grouping_changed", {
			group_by: value,
			project_id: projectId,
		});
	};

	// First load: spinner on the dedicated page, nothing when embedded (no flicker).
	if (isLoading && summary.total === 0) {
		if (!standalone) return null;
		return (
			<Card withBorder p="lg" radius="sm">
				<Stack align="center">
					<DembraneLoadingSpinner isLoading showMessage={false} />
				</Stack>
			</Card>
		);
	}

	// Both channels failed with no data: say so instead of a misleading empty state.
	if (error && summary.total === 0) {
		if (!standalone) return null;
		return (
			<Card withBorder p="lg" radius="sm">
				<Stack gap="xs" align="center">
					<WarningCircleIcon size={24} />
					<Text size="sm" fw={500}>
						<Trans>Couldn't load live activity</Trans>
					</Text>
					<Text size="xs" ta="center" maw={420}>
						<Trans>The connection dropped. Retrying automatically.</Trans>
					</Text>
				</Stack>
			</Card>
		);
	}

	if (summary.total === 0) {
		if (!standalone) return null;
		return (
			<Card withBorder p="lg" radius="sm">
				<Stack gap="xs" align="center">
					<BroadcastIcon size={24} />
					<Text size="sm" fw={500}>
						<Trans>No recent activity</Trans>
					</Text>
					<Text size="xs" ta="center" maw={420}>
						<Trans>
							Live recordings, transcription progress, and errors show up here
							as participants start recording in the portal.
						</Trans>
					</Text>
				</Stack>
			</Card>
		);
	}

	return (
		<>
			<Stack gap="lg">
				{!hideHeader && (
					<Group justify="space-between" align="center" gap="sm">
						<Group gap="xs" align="center">
							<BroadcastIcon size={16} />
							<Text size="xs" tt="uppercase">
								<Trans>Live monitoring</Trans>
							</Text>
						</Group>
						<Group gap="xs" align="center">
							<SegmentedControl
								size="xs"
								value={groupBy}
								onChange={handleGroupByChange}
								aria-label={t`Group by`}
								data={[
									{ label: t`By tag`, value: "tag" },
									{ label: t`By status`, value: "status" },
								]}
								mr="xs"
							/>

							{/* Informational only. All of these read the same: grey border,
							    charcoal text, matching the "catch up" tag. */}
							<Group gap="xs" align="center">
								<MonitorBadge size="sm" color="gray" variant="outline">
									<Plural value={summary.live} one="# live" other="# live" />
								</MonitorBadge>
								{summary.offline > 0 && (
									<MonitorBadge
										size="sm"
										color="gray"
										variant="outline"
										leftSection={<WifiSlashIcon size={12} />}
									>
										<Plural
											value={summary.offline}
											one="# offline"
											other="# offline"
										/>
									</MonitorBadge>
								)}
								{summary.not_receiving > 0 && (
									<MonitorBadge
										size="sm"
										color="gray"
										variant="outline"
										leftSection={<WarningCircleIcon size={12} />}
									>
										<Plural
											value={summary.not_receiving}
											one="# audio stopped"
											other="# audio stopped"
										/>
									</MonitorBadge>
								)}
								{summary.transcribing > 0 && (
									<MonitorBadge size="sm" color="gray" variant="outline">
										<Plural
											value={summary.transcribing}
											one="# transcribing"
											other="# transcribing"
										/>
									</MonitorBadge>
								)}
								{summary.with_errors > 0 && (
									<MonitorBadge
										size="sm"
										color="gray"
										variant="outline"
										leftSection={<WarningCircleIcon size={12} />}
									>
										<Plural
											value={summary.with_errors}
											one="# with errors"
											other="# with errors"
										/>
									</MonitorBadge>
								)}
							</Group>

							{(!isStreaming ||
								!!catchUpLabel(summary.catch_up_eta_seconds)) && (
								<Group gap="xs" align="center" style={{ opacity: 0.65 }}>
									<Divider orientation="vertical" h={14} />
									{!isStreaming && (
										<Tooltip
											label={t`Live stream disconnected. Updating on a slower poll until it reconnects.`}
											withArrow
										>
											<MonitorBadge size="sm" color="gray" variant="outline">
												<Trans>Reconnecting</Trans>
											</MonitorBadge>
										</Tooltip>
									)}
									{catchUpLabel(summary.catch_up_eta_seconds) && (
										<Tooltip
											label={t`Rough estimate to finish transcribing the backlog`}
											withArrow
										>
											<MonitorBadge size="sm" color="gray" variant="outline">
												<Trans>
													catch up {catchUpLabel(summary.catch_up_eta_seconds)}
												</Trans>
											</MonitorBadge>
										</Tooltip>
									)}
								</Group>
							)}
						</Group>
					</Group>
				)}

				{groups.map((group) => (
					<MonitorGroupSection
						key={group.key}
						group={group}
						highlightedConversationId={highlightedConversationId}
						onLockedClick={(conversation) => {
							posthog.capture("monitor_locked_row_clicked", {
								conversation_id: conversation.id,
								project_id: projectId,
							});
							upgradeHandlers.open();
						}}
						onEdit={(conversation) => {
							posthog.capture("monitor_drilldown_opened", {
								entity_type: "recording",
								project_id: projectId,
								stage_or_state: conversation.state,
							});
							setSelectedId(conversation.id);
						}}
					/>
				))}
			</Stack>
			<ConversationDrilldownModal
				conversation={selected}
				base={base}
				projectId={projectId}
				onClose={() => setSelectedId(null)}
			/>
			<UpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				currentTier={(workspace?.tier ?? "free") as Tier}
				requiredTier={SELLABLE_TIER}
				featureName="Transcripts"
				benefit={t`Upgrade your workspace to view transcripts for new conversations.`}
				canRequestUpgrade={
					workspace?.role === "admin" || workspace?.role === "owner"
				}
				workspaceId={workspace?.id ?? workspaceId ?? ""}
				source="transcript_locked"
			/>
		</>
	);
};
