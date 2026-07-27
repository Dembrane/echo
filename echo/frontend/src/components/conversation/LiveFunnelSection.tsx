import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Box, Card, Group, Modal, Stack, Text } from "@mantine/core";
import { BatteryLowIcon, WifiSlashIcon } from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import posthog from "posthog-js";
import { useMemo, useState } from "react";
import { useParams } from "react-router";

import {
	type FunnelStage,
	type FunnelVisitor,
	useConversationMonitor,
} from "@/hooks/useConversationMonitor";
import { ConversationDrilldownModal } from "./ConversationDrilldownModal";
import { FunnelCanvas, type NodeDatum } from "./FunnelCanvas";
import { MonitorBadge } from "./MonitorBadge";

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
				<MonitorBadge size="xs" color="gray" variant="light">
					<Trans>Scanned {visitor.scan_count} times</Trans>
				</MonitorBadge>
			)}
		</Group>
		{visitor.tags.length > 0 && (
			<Group gap={4} wrap="wrap">
				{visitor.tags.map((tag) => (
					<MonitorBadge
						key={tag}
						size="xs"
						variant="light"
						color={visitor.tags_preselected ? "primary" : "gray"}
					>
						{visitor.tags_preselected ? t`${tag} (preselected)` : tag}
					</MonitorBadge>
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
		<MonitorBadge size="xs" variant="light" color="gray">
			{count}
		</MonitorBadge>
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
	const [selectedVisitor, setSelectedVisitor] = useState<FunnelVisitor | null>(
		null,
	);
	// Track by id so the shared modal reads fresh snapshots (and closes when the
	// conversation is deleted / ages out).
	const [selectedConversationId, setSelectedConversationId] = useState<
		string | null
	>(null);
	const selectedConversation =
		conversations.find((c) => c.id === selectedConversationId) ?? null;

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
						onSelect={(node) => {
							posthog.capture("monitor_drilldown_opened", {
								entity_type: node.kind === "visitor" ? "visitor" : "recording",
								project_id: projectId,
								stage_or_state:
									node.kind === "visitor" ? node.data.stage : node.data.state,
							});
							if (node.kind === "visitor") {
								setSelectedVisitor(node.data);
							} else {
								setSelectedConversationId(node.data.id);
							}
						}}
						onHover={(node) =>
							onHoverConversation?.(
								node?.kind === "conversation" ? node.data.id : null,
							)
						}
					/>
				</Box>
			)}

			<Modal
				opened={selectedVisitor !== null}
				onClose={() => setSelectedVisitor(null)}
				title={t`Visitor details`}
				centered
				size="md"
			>
				{selectedVisitor && <VisitorDrilldown visitor={selectedVisitor} />}
			</Modal>

			<ConversationDrilldownModal
				conversation={selectedConversation}
				base={base}
				projectId={projectId}
				onClose={() => setSelectedConversationId(null)}
			/>
		</Stack>
	);
};
