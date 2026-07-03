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

const weakNetwork = (
	network: { online?: boolean; effective_type?: string } | null,
): boolean => {
	if (!network) return false;
	if (network.online === false) return true;
	return network.effective_type === "2g" || network.effective_type === "slow-2g";
};

const lowBattery = (
	battery: { level?: number; charging?: boolean } | null,
): boolean => {
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

const micStageLabel = (stage: FunnelStage): string | null => {
	if (stage === "mic_ok") return t`Mic OK`;
	if (stage === "mic_skipped") return t`Mic skipped`;
	if (stage === "mic_blocked") return t`Mic blocked`;
	return null;
};

const visitorDotColor = (stage: FunnelStage): string => {
	if (stage === "mic_blocked") return "var(--mantine-color-red-6)";
	if (stage === "mic_ok") return "var(--mantine-color-green-6)";
	if (stage === "profile") return "var(--mantine-color-primary-6)";
	return "var(--mantine-color-gray-5)";
};

type Selection =
	| { kind: "visitor"; visitor: FunnelVisitor }
	| { kind: "conversation"; conversation: MonitorConversation };

// A small clickable dot; the atom of every lane. Hovering a recording dot
// highlights its detailed card in the list below.
const Dot = ({
	color,
	label,
	pulse,
	warn,
	icon,
	onOpen,
	onHoverStart,
	onHoverEnd,
}: {
	color: string;
	label: string;
	pulse?: boolean;
	warn?: boolean;
	icon?: React.ReactNode;
	onOpen: () => void;
	onHoverStart?: () => void;
	onHoverEnd?: () => void;
}) => (
	<Tooltip label={label} openDelay={150} withArrow>
		<button
			type="button"
			onClick={onOpen}
			onMouseEnter={onHoverStart}
			onMouseLeave={onHoverEnd}
			onFocus={onHoverStart}
			onBlur={onHoverEnd}
			aria-label={label}
			className="relative flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-125"
			style={{ backgroundColor: color }}
		>
			{pulse && (
				<span
					className="absolute inset-0 rounded-full animate-ping"
					style={{ backgroundColor: color, opacity: 0.5 }}
				/>
			)}
			{icon}
			{warn && (
				<span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-orange-400" />
			)}
		</button>
	</Tooltip>
);

type Lane = {
	key: string;
	label: string;
	visitors: FunnelVisitor[];
	recordings: MonitorConversation[];
	count: number;
};

const FunnelLane = ({
	lane,
	onOpenVisitor,
	onOpenConversation,
	onHoverConversation,
}: {
	lane: Lane;
	onOpenVisitor: (visitor: FunnelVisitor) => void;
	onOpenConversation: (conversation: MonitorConversation) => void;
	onHoverConversation: (id: string | null) => void;
}) => {
	const [opened, { toggle }] = useDisclosure(true);
	return (
		<Stack gap="xs" className="min-w-[150px] flex-1">
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
				{lane.count === 0 ? (
					<Text size="xs" c="dimmed" className="pl-1">
						<Trans>Nobody here yet</Trans>
					</Text>
				) : (
					<Group gap={8} wrap="wrap">
						{lane.visitors.map((visitor) => (
							<Dot
								key={visitor.id}
								color={visitorDotColor(visitor.stage)}
								label={micStageLabel(visitor.stage) ?? visitor.name?.trim() ?? t`Anonymous`}
								warn={weakNetwork(visitor.network) || lowBattery(visitor.battery)}
								icon={
									visitor.stage === "mic_ok" ? (
										<CheckIcon size={10} color="white" weight="bold" />
									) : visitor.stage === "mic_blocked" ? (
										<WarningCircleIcon size={11} color="white" weight="bold" />
									) : undefined
								}
								onOpen={() => onOpenVisitor(visitor)}
							/>
						))}
						{lane.recordings.map((conversation) => (
							<Dot
								key={conversation.id}
								color="var(--mantine-color-red-6)"
								pulse
								label={conversation.label?.trim() || t`Anonymous`}
								warn={weakNetwork(conversation.network) || lowBattery(conversation.battery)}
								onOpen={() => onOpenConversation(conversation)}
								onHoverStart={() => onHoverConversation(conversation.id)}
								onHoverEnd={() => onHoverConversation(null)}
							/>
						))}
					</Group>
				)}
			</Collapse>
		</Stack>
	);
};

const STAGE_TIMELINE_ORDER: { stage: FunnelStage; label: string }[] = [
	{ stage: "scanned", label: t`Scanned the QR` },
	{ stage: "terms", label: t`Accepted terms` },
	{ stage: "mic_ok", label: t`Mic checked` },
	{ stage: "mic_skipped", label: t`Skipped mic check` },
	{ stage: "mic_blocked", label: t`Mic blocked` },
	{ stage: "profile", label: t`Entered details` },
];

const StageTimeline = ({ stages }: { stages: Record<string, string> }) => {
	const steps = STAGE_TIMELINE_ORDER.filter((step) => stages[step.stage]).map(
		(step) => ({ ...step, at: stages[step.stage] }),
	);
	if (steps.length === 0) return null;
	return (
		<Stack gap={4}>
			<Text size="xs" fw={600} tt="uppercase" c="dimmed">
				<Trans>Timeline</Trans>
			</Text>
			{steps.map((step) => (
				<Group key={step.stage} gap="xs" justify="space-between" wrap="nowrap">
					<Text size="xs">{step.label}</Text>
					<Text size="xs" c="dimmed">
						{relativeTime(step.at)}
					</Text>
				</Group>
			))}
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
		<StageTimeline stages={visitor.stages} />
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

export const LiveFunnelSection = ({
	projectId,
	onHoverConversation,
}: {
	projectId: string;
	/** Notifies the parent which recording is hovered, so the detailed card
	 * below can highlight. */
	onHoverConversation?: (id: string | null) => void;
}) => {
	const { funnel, conversations } = useConversationMonitor(projectId);
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const base =
		workspaceId && projectId ? `/w/${workspaceId}/projects/${projectId}` : null;
	const [selected, setSelected] = useState<Selection | null>(null);

	const lanes = useMemo<Lane[]>(() => {
		const byStage = (stages: FunnelStage[]) =>
			funnel.visitors.filter((v) => stages.includes(v.stage));
		const recording = conversations.filter((c) => c.is_live);
		const make = (
			key: string,
			label: string,
			visitors: FunnelVisitor[],
			recordings: MonitorConversation[] = [],
		): Lane => ({
			key,
			label,
			visitors,
			recordings,
			count: visitors.length + recordings.length,
		});
		// Three lanes, like a gravity drop: Scanned -> Setting up -> Recording.
		// "Setting up" merges terms, mic check, and name/tags; a blocked mic
		// still surfaces as a warning dot inside it.
		return [
			make("scanned", t`Scanned`, byStage(["scanned"])),
			make(
				"setup",
				t`Setting up`,
				byStage(["terms", "mic_ok", "mic_skipped", "mic_blocked", "profile"]),
			),
			make("recording", t`Recording`, [], recording),
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
				<Box className="flex flex-wrap gap-x-6 gap-y-4">
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
							onHoverConversation={(id) => onHoverConversation?.(id)}
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
