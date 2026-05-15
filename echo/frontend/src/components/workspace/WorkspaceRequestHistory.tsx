import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, Paper, Stack, Text, Timeline } from "@mantine/core";
import { IconCheck, IconClock, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

interface RequestHistoryItem {
	id: string;
	kind: string;
	status: string;
	proposed_tier: string;
	requester_message: string | null;
	requester_name: string | null;
	granted_tier: string | null;
	granted_tier_expires_at: string | null;
	denial_reason: string | null;
	decided_at: string | null;
	created_at: string | null;
}

interface RequestHistoryResponse {
	requests: RequestHistoryItem[];
	has_pending: boolean;
}

const statusColor: Record<string, string> = {
	pending: "yellow",
	approved: "primary",
	denied: "red",
};

const statusIcon: Record<string, React.ReactNode> = {
	pending: <IconClock size={12} />,
	approved: <IconCheck size={12} />,
	denied: <IconX size={12} />,
};

const kindLabel: Record<string, string> = {
	new_workspace: "New workspace",
	tier_upgrade: "Tier upgrade",
};

function formatDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function WorkspaceRequestHistory({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "workspace-requests", workspaceId],
		queryFn: async (): Promise<RequestHistoryResponse> => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/requests`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error("Failed to load request history");
			return res.json();
		},
		staleTime: 60_000,
	});

	if (isLoading || !data || data.requests.length === 0) return null;

	return (
		<Paper p="md" withBorder radius="sm">
			<Stack gap="md">
				<Text size="sm" fw={500}>
					<Trans>Upgrade requests</Trans>
				</Text>
				<Timeline bulletSize={24} lineWidth={2}>
					{data.requests.map((req) => (
						<Timeline.Item
							key={req.id}
							bullet={statusIcon[req.status] ?? <IconClock size={12} />}
							color={statusColor[req.status] ?? "gray"}
						>
							<Group gap="xs" wrap="nowrap">
								<Badge
									size="xs"
									color={statusColor[req.status] ?? "gray"}
									variant="light"
									tt="capitalize"
								>
									{req.status}
								</Badge>
								<Text size="xs" c="dimmed">
									{kindLabel[req.kind] ?? req.kind}
								</Text>
								<Badge size="xs" variant="outline" tt="capitalize">
									{req.granted_tier ?? req.proposed_tier}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed" mt={4}>
								{formatDate(req.created_at)}
								{req.requester_name && ` · ${req.requester_name}`}
							</Text>
							{req.status === "denied" && req.denial_reason && (
								<Text size="xs" c="red" mt={4}>
									{req.denial_reason}
								</Text>
							)}
							{req.status === "pending" && (
								<Text size="xs" c="yellow.8" mt={4}>
									<Trans>Pending review</Trans>
								</Text>
							)}
						</Timeline.Item>
					))}
				</Timeline>
			</Stack>
		</Paper>
	);
}
