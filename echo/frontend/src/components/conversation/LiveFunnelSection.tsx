import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Card,
	Group,
	Modal,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import {
	BatteryLowIcon,
	PencilSimpleIcon,
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
import { FunnelCanvas, type NodeDatum } from "./FunnelCanvas";
import { StatePill } from "./LiveMonitorSection";

const weakNetwork = (
	network: { online?: boolean; effective_type?: string } | null,
): boolean => {
	if (!network) return false;
	if (network.online === false) return true;
	return (
		network.effective_type === "2g" || network.effective_type === "slow-2g"
	);
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

type Selection =
	| { kind: "visitor"; visitor: FunnelVisitor }
	| { kind: "conversation"; conversation: MonitorConversation };

const STAGE_TIMELINE_ORDER: { stage: FunnelStage; label: string }[] = [
	{ label: t`Scanned the QR`, stage: "scanned" },
	{ label: t`Accepted terms`, stage: "terms" },
	{ label: t`Mic checked`, stage: "mic_ok" },
	{ label: t`Skipped mic check`, stage: "mic_skipped" },
	{ label: t`Mic blocked`, stage: "mic_blocked" },
	{ label: t`Entered details`, stage: "profile" },
];

const StageTimeline = ({ stages }: { stages: Record<string, string> }) => {
	const steps = STAGE_TIMELINE_ORDER.filter((step) => stages[step.stage]).map(
		(step) => ({ ...step, at: stages[step.stage] }),
	);
	if (steps.length === 0) return null;
	return (
		<Stack gap={4}>
			<Text size="xs" fw={600} tt="uppercase">
				<Trans>Timeline</Trans>
			</Text>
			{steps.map((step) => (
				<Group key={step.stage} gap="xs" justify="space-between" wrap="nowrap">
					<Text size="xs">{step.label}</Text>
					<Text size="xs">{relativeTime(step.at)}</Text>
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
			{visitor.device && <Text size="xs">{visitor.device}</Text>}
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
				onError: () => toast.error(t`Could not save`),
				onSuccess: () => toast.success(t`Saved`),
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
				<StatePill state={conversation.state} />
				{conversation.has_error && (
					<Text size="xs" c="red.7">
						<Trans>
							Some of the recent audio couldn't be transcribed. The recording is
							saved.
						</Trans>
					</Text>
				)}
			</Group>
			{base && (
				<I18nLink
					to={`${base}/conversations/${conversation.id}`}
					className="no-underline"
				>
					<Button variant="light" size="xs">
						<Trans>Open conversation</Trans>
					</Button>
				</I18nLink>
			)}
		</Stack>
	);
};

const StageLabel = ({
	label,
	count,
	weight,
}: {
	label: string;
	count: number;
	weight: number;
}) => (
	<Group
		gap="xs"
		align="center"
		className="justify-center"
		style={{ flexBasis: 0, flexGrow: weight }}
	>
		<Text size="xs" fw={600} tt="uppercase">
			{label}
		</Text>
		<Badge size="xs" variant="light" color="gray">
			{count}
		</Badge>
	</Group>
);

export const LiveFunnelSection = ({
	projectId,
	onHoverConversation,
}: {
	projectId: string;
	onHoverConversation?: (id: string | null) => void;
}) => {
	const { funnel, conversations } = useConversationMonitor(projectId);
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const base =
		workspaceId && projectId ? `/w/${workspaceId}/projects/${projectId}` : null;
	const [selected, setSelected] = useState<Selection | null>(null);

	const { nodes, counts, weights } = useMemo(() => {
		const recording = conversations.filter((c) => c.is_live);
		const visitorNodes: NodeDatum[] = funnel.visitors.map((data) => ({
			data,
			kind: "visitor",
		}));
		const recordingNodes: NodeDatum[] = recording.map((data) => ({
			data,
			kind: "conversation",
		}));
		const scanned = funnel.visitors.filter((v) => v.stage === "scanned").length;
		const setup = funnel.visitors.length - scanned;
		return {
			counts: { recording: recording.length, scanned, setup },
			nodes: [...visitorNodes, ...recordingNodes],
			// Empty stages shrink; recording carries extra weight so an
			// all-recording view reads ~25/25/50.
			weights: [
				Math.max(1, scanned),
				Math.max(1, setup),
				Math.max(2, recording.length),
			] as [number, number, number],
		};
	}, [funnel.visitors, conversations]);

	const totalActive = nodes.length;

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<Text size="xs" tt="uppercase">
					<Trans>Live participant flow</Trans>
				</Text>
				<Text size="xs">
					<Plural value={totalActive} one="# active" other="# active" />
				</Text>
			</Group>

			{totalActive === 0 ? (
				<Card withBorder p="lg" radius="sm">
					<Text size="sm" ta="center">
						<Trans>
							When participants scan the QR code, they'll appear here and flow
							across the stages in real time.
						</Trans>
					</Text>
				</Card>
			) : (
				<Box>
					<Group gap={0} justify="space-between" mb={4}>
						<StageLabel
							label={t`Scanned`}
							count={counts.scanned}
							weight={weights[0]}
						/>
						<StageLabel
							label={t`Setting up`}
							count={counts.setup}
							weight={weights[1]}
						/>
						<StageLabel
							label={t`Recording`}
							count={counts.recording}
							weight={weights[2]}
						/>
					</Group>
					<FunnelCanvas
						nodes={nodes}
						weights={weights}
						onSelect={(node) =>
							setSelected(
								node.kind === "visitor"
									? { kind: "visitor", visitor: node.data }
									: { conversation: node.data, kind: "conversation" },
							)
						}
						onHover={(node) =>
							onHoverConversation?.(
								node?.kind === "conversation" ? node.data.id : null,
							)
						}
					/>
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
