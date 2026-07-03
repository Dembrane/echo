import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Card,
	Collapse,
	Group,
	Modal,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	BatteryLowIcon,
	CaretRightIcon,
	CheckIcon,
	PencilSimpleIcon,
	WarningCircleIcon,
	WifiSlashIcon,
} from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";

import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { useUpdateConversationByIdMutation } from "@/components/conversation/hooks";
import {
	type FunnelStage,
	type FunnelVisitor,
	type MonitorConversation,
	useConversationMonitor,
} from "@/hooks/useConversationMonitor";

const weakNetwork = (network: {
	online?: boolean;
	effective_type?: string;
} | null): boolean => {
	if (!network) return false;
	if (network.online === false) return true;
	return network.effective_type === "2g" || network.effective_type === "slow-2g";
};

const lowBattery = (battery: {
	level?: number;
	charging?: boolean;
} | null): boolean => {
	if (!battery || battery.charging) return false;
	return typeof battery.level === "number" && battery.level <= 0.15;
};

const relativeTime = (stamp: string | null): string => {
	if (!stamp) return t`just now`;
	try {
		return formatDistanceToNow(new Date(stamp), { addSuffix: true });
	} catch {
		return stamp;
	}
};

const micStageMeta = (
	stage: FunnelStage,
): { color: string; label: string } | null => {
	if (stage === "mic_ok") return { color: "green", label: t`Mic OK` };
	if (stage === "mic_skipped") return { color: "gray", label: t`Mic skipped` };
	if (stage === "mic_blocked") return { color: "red", label: t`Mic blocked` };
	return null;
};

// ── selection for the same-screen drilldown ──────────────────────────
type Selection =
	| { kind: "visitor"; visitor: FunnelVisitor }
	| { kind: "conversation"; conversation: MonitorConversation };

const VisitorDot = ({
	visitor,
	onOpen,
}: {
	visitor: FunnelVisitor;
	onOpen: () => void;
}) => {
	const mic = micStageMeta(visitor.stage);
	const warn = weakNetwork(visitor.network) || lowBattery(visitor.battery);
	const color =
		visitor.stage === "mic_blocked"
			? "var(--mantine-color-red-6)"
			: visitor.stage === "mic_ok"
				? "var(--mantine-color-green-6)"
				: "var(--mantine-color-gray-5)";
	return (
		<Tooltip
			label={mic?.label ?? (visitor.name?.trim() || t`Anonymous`)}
			openDelay={200}
			withArrow
		>
			<button
				type="button"
				onClick={onOpen}
				aria-label={visitor.name?.trim() || t`Visitor`}
				className="relative flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110"
				style={{ backgroundColor: color, opacity: 0.9 }}
			>
				{visitor.stage === "mic_ok" && (
					<CheckIcon size={12} color="white" weight="bold" />
				)}
				{visitor.stage === "mic_blocked" && (
					<WarningCircleIcon size={13} color="white" weight="bold" />
				)}
				{warn && (
					<span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-orange-400" />
				)}
			</button>
		</Tooltip>
	);
};

const VisitorMiniCard = ({
	visitor,
	onOpen,
}: {
	visitor: FunnelVisitor;
	onOpen: () => void;
}) => (
	<Card
		withBorder
		p="xs"
		radius="md"
		className="cursor-pointer transition-colors hover:!border-primary-400"
		onClick={onOpen}
	>
		<Group gap={6} justify="space-between" wrap="nowrap">
			<Text size="sm" fw={500} truncate>
				{visitor.name?.trim() || t`Anonymous`}
			</Text>
			{visitor.scan_count > 1 && (
				<Badge size="xs" color="gray" variant="light">
					<Trans>×{visitor.scan_count}</Trans>
				</Badge>
			)}
		</Group>
		{visitor.tags.length > 0 && (
			<Group gap={4} mt={4} wrap="wrap">
				{visitor.tags.slice(0, 3).map((tag) => (
					<Badge
						key={tag}
						size="xs"
						variant="light"
						color={visitor.tags_preselected ? "primary" : "gray"}
					>
						{tag}
					</Badge>
				))}
			</Group>
		)}
	</Card>
);

const RecordingCard = ({
	conversation,
	onOpen,
}: {
	conversation: MonitorConversation;
	onOpen: () => void;
}) => (
	<Card
		withBorder
		p="xs"
		radius="md"
		className="cursor-pointer transition-colors hover:!border-primary-400"
		onClick={onOpen}
	>
		<Group gap={6} justify="space-between" wrap="nowrap">
			<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
				<span className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500 animate-pulse" />
				<Text size="sm" fw={500} truncate>
					{conversation.label?.trim() || t`Anonymous`}
				</Text>
			</Group>
			{conversation.has_error && (
				<WarningCircleIcon size={15} className="shrink-0 text-red-500" />
			)}
		</Group>
		<Group gap={4} mt={4} wrap="wrap">
			{conversation.state === "paused" && (
				<Badge size="xs" color="yellow" variant="light">
					<Trans>Paused</Trans>
				</Badge>
			)}
			{conversation.state === "verifying" && (
				<Badge size="xs" color="blue" variant="light">
					<Trans>Verifying</Trans>
				</Badge>
			)}
			{conversation.transcription_status === "transcribing" && (
				<Badge size="xs" color="blue" variant="light">
					<Trans>Transcribing</Trans>
				</Badge>
			)}
		</Group>
	</Card>
);

type Lane = {
	key: string;
	label: string;
	dots?: FunnelVisitor[];
	cards?: FunnelVisitor[];
	recordings?: MonitorConversation[];
	count: number;
};

const FunnelLane = ({
	lane,
	onOpenVisitor,
	onOpenConversation,
}: {
	lane: Lane;
	onOpenVisitor: (visitor: FunnelVisitor) => void;
	onOpenConversation: (conversation: MonitorConversation) => void;
}) => {
	const [opened, { toggle }] = useDisclosure(true);
	return (
		<Stack gap="xs" className="min-w-[190px] flex-1">
			<Group
				gap="xs"
				align="center"
				wrap="nowrap"
				className="cursor-pointer select-none"
				onClick={toggle}
			>
				<ActionIcon variant="subtle" color="gray" size="sm" aria-hidden>
					<CaretRightIcon
						size={14}
						style={{
							transition: "transform 150ms ease",
							transform: opened ? "rotate(90deg)" : "none",
						}}
					/>
				</ActionIcon>
				<Text size="xs" fw={600} tt="uppercase" c="dimmed" truncate>
					{lane.label}
				</Text>
				<Badge size="xs" variant="light" color="gray">
					{lane.count}
				</Badge>
			</Group>
			<Collapse in={opened}>
				<Stack gap="xs">
					{lane.dots && lane.dots.length > 0 && (
						<Group gap={6} wrap="wrap">
							{lane.dots.map((visitor) => (
								<VisitorDot
									key={visitor.id}
									visitor={visitor}
									onOpen={() => onOpenVisitor(visitor)}
								/>
							))}
						</Group>
					)}
					{lane.cards?.map((visitor) => (
						<VisitorMiniCard
							key={visitor.id}
							visitor={visitor}
							onOpen={() => onOpenVisitor(visitor)}
						/>
					))}
					{lane.recordings?.map((conversation) => (
						<RecordingCard
							key={conversation.id}
							conversation={conversation}
							onOpen={() => onOpenConversation(conversation)}
						/>
					))}
					{lane.count === 0 && (
						<Text size="xs" c="dimmed" className="pl-1">
							<Trans>Nobody here yet</Trans>
						</Text>
					)}
				</Stack>
			</Collapse>
		</Stack>
	);
};

const VisitorDrilldown = ({ visitor }: { visitor: FunnelVisitor }) => (
	<Stack gap="sm">
		<Group gap="xs">
			<Text size="sm" fw={500}>
				{visitor.name?.trim() || t`Anonymous visitor`}
			</Text>
			{visitor.scan_count > 1 && (
				<Badge size="xs" color="gray" variant="light">
					<Trans>Scanned {visitor.scan_count} times</Trans>
				</Badge>
			)}
		</Group>
		<Text size="xs" c="dimmed">
			<Trans>Last seen {relativeTime(visitor.last_seen_at)}</Trans>
		</Text>
		{visitor.tags.length > 0 && (
			<Group gap={4} wrap="wrap">
				{visitor.tags.map((tag) => (
					<Badge
						key={tag}
						size="xs"
						variant="light"
						color={visitor.tags_preselected ? "primary" : "gray"}
					>
						{visitor.tags_preselected ? t`${tag} (preselected)` : tag}
					</Badge>
				))}
			</Group>
		)}
		<Group gap="lg">
			{visitor.device && (
				<Text size="xs" c="dimmed">
					{visitor.device}
				</Text>
			)}
			{weakNetwork(visitor.network) && (
				<Group gap={4}>
					<WifiSlashIcon size={14} className="text-orange-500" />
					<Text size="xs" c="orange.7">
						<Trans>Weak network</Trans>
					</Text>
				</Group>
			)}
			{lowBattery(visitor.battery) && (
				<Group gap={4}>
					<BatteryLowIcon size={15} className="text-orange-500" />
					<Text size="xs" c="orange.7">
						<Trans>Low battery</Trans>
					</Text>
				</Group>
			)}
		</Group>
	</Stack>
);

const ConversationDrilldown = ({
	conversation,
	base,
}: {
	conversation: MonitorConversation;
	base: string | null;
}) => {
	const [name, setName] = useState(conversation.label ?? "");
	const update = useUpdateConversationByIdMutation();

	useEffect(() => {
		setName(conversation.label ?? "");
	}, [conversation.label]);

	const save = () => {
		update.mutate(
			{ id: conversation.id, payload: { participant_name: name.trim() } },
			{
				onSuccess: () => toast.success(t`Saved`),
				onError: () => toast.error(t`Could not save`),
			},
		);
	};

	return (
		<Stack gap="sm">
			<TextInput
				label={t`Participant name`}
				value={name}
				onChange={(event) => setName(event.currentTarget.value)}
				rightSection={
					<ActionIcon
						variant="subtle"
						color="primary"
						onClick={save}
						loading={update.isPending}
						aria-label={t`Save`}
					>
						<PencilSimpleIcon size={15} />
					</ActionIcon>
				}
			/>
			<Group gap="md">
				<Text size="xs" c="dimmed" tt="capitalize">
					{conversation.state}
				</Text>
				{conversation.has_error && conversation.error_message && (
					<Text size="xs" c="red.7" lineClamp={1}>
						{conversation.error_message}
					</Text>
				)}
			</Group>
			{base && (
				<Button
					component={I18nLink}
					to={`${base}/conversations/${conversation.id}`}
					variant="light"
					size="xs"
				>
					<Trans>Open conversation</Trans>
				</Button>
			)}
		</Stack>
	);
};

export const LiveFunnelSection = ({ projectId }: { projectId: string }) => {
	const { funnel, conversations } = useConversationMonitor(projectId);
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const base =
		workspaceId && projectId
			? `/w/${workspaceId}/projects/${projectId}`
			: null;
	const [selected, setSelected] = useState<Selection | null>(null);

	const lanes = useMemo<Lane[]>(() => {
		const byStage = (stages: FunnelStage[]) =>
			funnel.visitors.filter((v) => stages.includes(v.stage));
		const recording = conversations.filter((c) => c.is_live);
		const scanned = byStage(["scanned"]);
		const terms = byStage(["terms"]);
		const mic = byStage(["mic_ok", "mic_skipped", "mic_blocked"]);
		const profile = byStage(["profile"]);
		return [
			{ key: "scanned", label: t`Scanned`, dots: scanned, count: scanned.length },
			{ key: "terms", label: t`Terms`, dots: terms, count: terms.length },
			{ key: "mic", label: t`Mic check`, dots: mic, count: mic.length },
			{
				key: "profile",
				label: t`Profile`,
				cards: profile,
				count: profile.length,
			},
			{
				key: "recording",
				label: t`Recording`,
				recordings: recording,
				count: recording.length,
			},
		];
	}, [funnel.visitors, conversations]);

	const totalActive = lanes.reduce((sum, lane) => sum + lane.count, 0);

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<Text size="xs" c="dimmed" tt="uppercase">
					<Trans>Live participant flow</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					<Plural value={totalActive} one="# active" other="# active" />
				</Text>
			</Group>

			{totalActive === 0 ? (
				<Card withBorder p="lg" radius="sm">
					<Text size="sm" c="dimmed" ta="center">
						<Trans>
							When participants scan the QR code, they'll appear here and move
							across the stages in real time.
						</Trans>
					</Text>
				</Card>
			) : (
				<Box className="flex gap-4 overflow-x-auto pb-2">
					{lanes.map((lane) => (
						<FunnelLane
							key={lane.key}
							lane={lane}
							onOpenVisitor={(visitor) =>
								setSelected({ kind: "visitor", visitor })
							}
							onOpenConversation={(conversation) =>
								setSelected({ kind: "conversation", conversation })
							}
						/>
					))}
				</Box>
			)}

			<Modal
				opened={selected !== null}
				onClose={() => setSelected(null)}
				title={
					selected?.kind === "conversation"
						? t`Conversation`
						: t`Visitor details`
				}
				centered
				size="md"
			>
				{selected?.kind === "visitor" && (
					<VisitorDrilldown visitor={selected.visitor} />
				)}
				{selected?.kind === "conversation" && (
					<ConversationDrilldown
						conversation={selected.conversation}
						base={base}
					/>
				)}
			</Modal>
		</Stack>
	);
};
