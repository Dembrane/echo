import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Card,
	Collapse,
	Group,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	BatteryLowIcon,
	BroadcastIcon,
	CaretRightIcon,
	WarningCircleIcon,
	WifiSlashIcon,
} from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import { I18nLink } from "@/components/common/i18nLink";
import {
	type MonitorConversation,
	type ParticipantState,
	useConversationMonitor,
} from "@/hooks/useConversationMonitor";

// How many rows to render per tag group before collapsing the rest behind a
// "show more" — keeps the page calm and bounded even for a busy tag.
const MAX_ROWS_PER_GROUP = 25;

type StateMeta = {
	color: string;
	label: string;
	pulse?: boolean;
	darkText?: boolean;
};

const stateMeta = (state: ParticipantState): StateMeta => {
	switch (state) {
		case "recording":
			return { color: "red", label: t`Recording`, pulse: true };
		case "paused":
			return { color: "yellow", label: t`Paused` };
		case "verifying":
			return { color: "primary", label: t`Verifying` };
		case "refining":
			return { color: "grape", label: t`Exploring` };
		case "text":
			return { color: "primary", label: t`Typing` };
		case "finishing":
			return { color: "primary", label: t`Finishing` };
		case "finished":
			return { color: "primary", label: t`Finished` };
		case "waiting":
			return { color: "gray", label: t`Waiting` };
		case "initiated":
			return { color: "gray", label: t`Just started` };
		case "offline":
			return { color: "salmon", darkText: true, label: t`Offline` };
		case "left":
			return { color: "gray", label: t`Left` };
		case "backgrounded":
			return { color: "gray", label: t`Away` };
		default:
			return { color: "gray", label: t`Idle` };
	}
};

export const StatePill = ({ state }: { state: ParticipantState }) => {
	const meta = stateMeta(state);
	const darkTextStyles = {
		label: { color: "var(--app-text)" },
		section: { color: "var(--app-text)" },
	};

	return (
		<Badge
			size="sm"
			color={meta.color}
			variant="light"
			styles={meta.darkText ? darkTextStyles : undefined}
			leftSection={
				<span
					aria-hidden
					className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${
						meta.pulse ? "animate-pulse" : ""
					}`}
				/>
			}
		>
			{meta.label}
		</Badge>
	);
};

// Signal-meter bar heights (px). Keyed by value (not index) to keep biome
// happy; the values are unique so that's stable.
const METER_HEIGHTS = [5, 7, 9, 11, 13];

/** A tiny 5-bar signal meter fed by the participant's live mic level (0..1).
 * Lifts low levels with a sqrt so quiet-but-present audio still reads, and
 * softly flags all-quiet ("is the mic muted?") without an alarm. */
const AudioLevelMeter = ({ level }: { level: number }) => {
	const scaled = Math.min(1, Math.sqrt(Math.max(0, level)));
	const active = Math.round(scaled * METER_HEIGHTS.length);
	return (
		<Tooltip
			label={
				active > 0
					? t`Audio is coming in`
					: t`Very quiet right now — check the mic isn't muted`
			}
			withArrow
		>
			<Group gap={2} align="flex-end" wrap="nowrap" aria-hidden>
				{METER_HEIGHTS.map((h, i) => (
					<Box
						key={h}
						style={{
							backgroundColor:
								i < active
									? "var(--mantine-color-green-6)"
									: "var(--mantine-color-gray-3)",
							borderRadius: 1,
							height: h,
							width: 3,
						}}
					/>
				))}
			</Group>
		</Tooltip>
	);
};

/** The latest transcript line, crossfading whenever it updates. */
const FadingTranscript = ({ text }: { text: string }) => {
	const [shown, setShown] = useState(text);
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		if (text === shown) return;
		setVisible(false);
		const timer = setTimeout(() => {
			setShown(text);
			setVisible(true);
		}, 180);
		return () => clearTimeout(timer);
	}, [text, shown]);

	return (
		<Text
			size="sm"
			lineClamp={2}
			style={{ opacity: visible ? 1 : 0, transition: "opacity 180ms ease" }}
		>
			{shown}
		</Text>
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

// Recorded length when we have it (set on finish), otherwise elapsed since the
// session started. It can be a little behind for a live session; that's fine.
const durationLabel = (conversation: MonitorConversation): string | null => {
	if (typeof conversation.duration === "number" && conversation.duration > 0) {
		return formatClock(conversation.duration);
	}
	if (conversation.created_at) {
		const start = new Date(conversation.created_at).getTime();
		if (!Number.isNaN(start)) return formatClock((Date.now() - start) / 1000);
	}
	return null;
};

// A duration that ticks up once a second for a live session, and reconciles to
// the server's value on each snapshot. Finished sessions just show the final
// duration (no ticking).
const LiveDuration = ({
	conversation,
}: {
	conversation: MonitorConversation;
}) => {
	const ticking = conversation.is_live && !conversation.is_finished;
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!ticking) return;
		const id = setInterval(() => setTick((value) => value + 1), 1000);
		return () => clearInterval(id);
	}, [ticking]);
	const label = durationLabel(conversation);
	if (!label) return null;
	return <Text size="xs">{label}</Text>;
};

// A deliberately vague, conservative "time to finish the transcription
// backlog", bucketed and rounded up so we never over-promise.
const catchUpLabel = (seconds: number): string | null => {
	if (!seconds || seconds <= 0) return null;
	const minutes = Math.ceil(seconds / 60);
	const bucket = [1, 2, 5, 10, 15, 20, 30].find((value) => value >= minutes);
	return bucket ? `~${bucket} min` : "~30+ min";
};

const lastActivityLabel = (conversation: MonitorConversation): string => {
	const stamp = conversation.last_seen_at ?? conversation.last_chunk_at;
	if (!stamp) return t`No activity yet`;
	try {
		return formatDistanceToNow(new Date(stamp), { addSuffix: true });
	} catch {
		return stamp;
	}
};

const TranscriptionBadge = ({
	conversation,
}: {
	conversation: MonitorConversation;
}) => {
	// A failing conversation already shows a red Error badge; don't double up.
	if (conversation.transcription_status === "failing") return null;
	if (conversation.transcription_status === "transcribing") {
		return (
			<Badge size="xs" color="primary" variant="light">
				<Plural
					value={conversation.pending_transcription}
					one="Transcribing # clip"
					other="Transcribing # clips"
				/>
			</Badge>
		);
	}
	if (
		conversation.transcription_status === "up_to_date" &&
		conversation.chunk_count > 0
	) {
		return (
			<Badge size="xs" color="green" variant="light">
				<Trans>Transcribed</Trans>
			</Badge>
		);
	}
	return null;
};

const MonitorRow = ({
	conversation,
	to,
	highlighted,
}: {
	conversation: MonitorConversation;
	to: string | null;
	highlighted?: boolean;
}) => {
	const label = conversation.label?.trim() || t`Anonymous participant`;
	const weakNetwork = isWeakNetwork(conversation);
	const lowBattery = isLowBattery(conversation);

	const card = (
		<Card
			withBorder
			p="sm"
			radius="sm"
			className={`transition-colors ${to ? "hover:!border-primary-400 cursor-pointer" : ""} ${highlighted ? "!border-primary-500 ring-2 ring-primary-200" : ""}`}
		>
			<Stack gap={8}>
				<Group justify="space-between" align="center" wrap="nowrap">
					<Group gap="xs" align="center" style={{ minWidth: 0 }}>
						<StatePill state={conversation.state} />
						<Text size="sm" fw={500} truncate>
							{label}
						</Text>
					</Group>
					<Group gap={6} align="center" wrap="nowrap">
						{conversation.recording_health === "receiving" &&
							typeof conversation.audio_level === "number" && (
								<AudioLevelMeter level={conversation.audio_level} />
							)}
						{conversation.recording_health === "stalled" && (
							<Tooltip
								label={t`Audio was coming in but stopped — they may have lost connection or locked their phone.`}
								multiline
								maw={280}
								withArrow
							>
								<Badge
									size="xs"
									color="orange"
									variant="filled"
									leftSection={<WarningCircleIcon size={12} />}
								>
									<Trans>Audio stopped?</Trans>
								</Badge>
							</Tooltip>
						)}
						{conversation.recording_health === "backgrounded" && (
							<Tooltip
								label={t`Their screen is locked or the tab is hidden — recording pauses until they come back.`}
								multiline
								maw={280}
								withArrow
							>
								<Badge size="xs" color="gray" variant="light">
									<Trans>Screen locked</Trans>
								</Badge>
							</Tooltip>
						)}
						{conversation.language && (
							<Badge size="xs" color="gray" variant="light" tt="uppercase">
								{conversation.language}
							</Badge>
						)}
						{weakNetwork && (
							<Tooltip label={t`Weak network`} withArrow>
								<WifiSlashIcon size={15} className="text-orange-500" />
							</Tooltip>
						)}
						{lowBattery && (
							<Tooltip label={t`Low battery`} withArrow>
								<BatteryLowIcon size={16} className="text-orange-500" />
							</Tooltip>
						)}
						<TranscriptionBadge conversation={conversation} />
						{conversation.has_error && (
							<Badge
								size="xs"
								color="red"
								variant="filled"
								leftSection={<WarningCircleIcon size={12} />}
							>
								<Trans>Error</Trans>
							</Badge>
						)}
					</Group>
				</Group>

				{conversation.latest_transcript && (
					<FadingTranscript text={conversation.latest_transcript} />
				)}

				<Group gap="md" align="center">
					<Text size="xs">
						<Trans>Last activity {lastActivityLabel(conversation)}</Trans>
					</Text>
					<LiveDuration conversation={conversation} />
				</Group>

				{conversation.has_error && (
					<Text size="xs" c="red.7">
						<Trans>
							Some of the recent audio couldn't be transcribed. The recording is
							saved.
						</Trans>
					</Text>
				)}
			</Stack>
		</Card>
	);

	if (!to) return card;
	return (
		<I18nLink to={to} className="block no-underline">
			{card}
		</I18nLink>
	);
};

const UNTAGGED = "__untagged__";

type TagGroup = {
	key: string;
	label: string;
	items: MonitorConversation[];
	liveCount: number;
};

const groupByTag = (conversations: MonitorConversation[]): TagGroup[] => {
	const groups = new Map<string, TagGroup>();
	const order: string[] = [];
	for (const conversation of conversations) {
		// A conversation lives under its first tag (or an Untagged bucket), so
		// each row appears once. Grouping keeps a busy project scannable.
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
	// Groups with live activity first; the Untagged bucket sinks to the end.
	return order
		.map((tag) => groups.get(tag) as TagGroup)
		.sort((a, b) => {
			if ((a.key === UNTAGGED) !== (b.key === UNTAGGED)) {
				return a.key === UNTAGGED ? 1 : -1;
			}
			return b.liveCount - a.liveCount;
		});
};

const TagGroupSection = ({
	group,
	base,
	highlightedConversationId,
}: {
	group: TagGroup;
	base: string | null;
	highlightedConversationId?: string | null;
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
					<Badge size="xs" color="primary" variant="light">
						<Plural value={group.liveCount} one="# live" other="# live" />
					</Badge>
				)}
			</Group>
			<Collapse in={opened}>
				<Stack gap="xs">
					{visible.map((conversation) => (
						<MonitorRow
							key={conversation.id}
							conversation={conversation}
							to={base ? `${base}/conversations/${conversation.id}` : null}
							highlighted={conversation.id === highlightedConversationId}
						/>
					))}
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
	/** Row to highlight (hovered from the funnel above). */
	highlightedConversationId?: string | null;
	/** Suppress the internal "Live monitoring" header + chips (when embedded
	 * under a shared section header, e.g. the project home). */
	hideHeader?: boolean;
}) => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const { conversations, summary, isLoading, error, isStreaming } =
		useConversationMonitor(projectId);
	const groups = useMemo(() => groupByTag(conversations), [conversations]);
	// Rows link to the conversation detail page when we know the workspace.
	const base =
		workspaceId && projectId ? `/w/${workspaceId}/projects/${projectId}` : null;

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
						{!isStreaming && (
							<Tooltip
								label={t`Live stream disconnected. Updating on a slower poll until it reconnects.`}
								withArrow
							>
								<Badge size="sm" color="orange" variant="light">
									<Trans>Reconnecting</Trans>
								</Badge>
							</Tooltip>
						)}
						<Badge size="sm" color="primary" variant="light">
							<Plural value={summary.live} one="# live" other="# live" />
						</Badge>
						{summary.offline > 0 && (
							<Badge
								size="sm"
								color="salmon"
								variant="light"
								styles={{
									label: { color: "var(--app-text)" },
									section: { color: "var(--app-text)" },
								}}
								leftSection={<WifiSlashIcon size={12} />}
							>
								<Plural
									value={summary.offline}
									one="# offline"
									other="# offline"
								/>
							</Badge>
						)}
						{summary.not_receiving > 0 && (
							<Badge
								size="sm"
								color="orange"
								variant="filled"
								leftSection={<WarningCircleIcon size={12} />}
							>
								<Plural
									value={summary.not_receiving}
									one="# audio stopped"
									other="# audio stopped"
								/>
							</Badge>
						)}
						{summary.transcribing > 0 && (
							<Badge size="sm" color="primary" variant="light">
								<Plural
									value={summary.transcribing}
									one="# transcribing"
									other="# transcribing"
								/>
							</Badge>
						)}
						{summary.with_errors > 0 && (
							<Badge size="sm" color="red" variant="light">
								<Plural
									value={summary.with_errors}
									one="# with errors"
									other="# with errors"
								/>
							</Badge>
						)}
						{catchUpLabel(summary.catch_up_eta_seconds) && (
							<Tooltip
								label={t`Rough estimate to finish transcribing the backlog`}
								withArrow
							>
								<Badge size="sm" color="orange" variant="light">
									<Trans>
										catch up {catchUpLabel(summary.catch_up_eta_seconds)}
									</Trans>
								</Badge>
							</Tooltip>
						)}
					</Group>
				</Group>
			)}

			<Stack gap="lg">
				{groups.map((group) => (
					<TagGroupSection
						key={group.key}
						group={group}
						base={base}
						highlightedConversationId={highlightedConversationId}
					/>
				))}
			</Stack>
		</Stack>
	);
};
