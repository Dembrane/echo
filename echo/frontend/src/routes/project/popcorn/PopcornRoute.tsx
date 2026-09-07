import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	SimpleGrid,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { format } from "date-fns";
import { useEffect } from "react";
import { useParams } from "react-router";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	type PopcornDetail,
	useInvalidatePopcorn,
	useProjectPopcorn,
} from "@/components/popcorn/hooks";
import { PopcornActions } from "@/components/popcorn/PopcornActions";
import { PopcornHistory } from "@/components/popcorn/PopcornHistory";
import { PopcornIntroModal } from "@/components/popcorn/PopcornIntroModal";
import { PopcornScreenSettings } from "@/components/popcorn/PopcornScreenSettings";
import { PopcornShare } from "@/components/popcorn/PopcornShare";
import { PopcornStart } from "@/components/popcorn/PopcornStart";
import { PopcornStatus } from "@/components/popcorn/PopcornStatus";
import { PopcornVoiceSection } from "@/components/popcorn/PopcornVoiceSection";
import { useProjectById } from "@/components/project/hooks";
import { API_BASE_URL, ENABLE_CANVAS } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";

function statusLine(popcorn: PopcornDetail): string {
	const loop = popcorn.loop;
	const counts = popcorn.counts;
	if (counts.conversations === 0) return t`Waiting for the first conversation`;
	const parts = [
		t`${counts.conversations} conversations`,
		t`${counts.phrases} phrases`,
		t`${counts.validated ?? 0} validated`,
	];
	if (counts.held_back) parts.push(t`${counts.held_back} held back`);
	if (loop?.mode === "live") {
		const expiry = loop.expires_at ? new Date(loop.expires_at) : null;
		const every = loop.cadence_minutes ?? 2;
		parts.push(
			expiry && !Number.isNaN(expiry.getTime())
				? t`live until ${format(expiry, "EEE d MMM, HH:mm")}, reads every ${every} min`
				: t`live, reads every ${every} min`,
		);
	}
	return parts.join(" · ");
}

// The dashboard is the control surface: what the session did, what a host
// can do with it, and every switch the room's screen answers to. The screen
// itself opens in its own tab, the presenter view.
function PopcornSession({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const invalidate = useInvalidatePopcorn(projectId);
	useDocumentTitle(`${popcorn.name} | dembrane`);

	// The deck polls its own data; this stream keeps the counts and the status
	// line in step with the tick.
	useEffect(() => {
		let source: EventSource | null = null;
		let closed = false;
		let reconnectTimer: number | null = null;
		let retryMs = 1000;
		const connect = () => {
			if (closed) return;
			source = new EventSource(
				`${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(popcorn.id)}/events`,
				{ withCredentials: true },
			);
			source.addEventListener("connected", () => {
				retryMs = 1000;
			});
			source.addEventListener("update", () => {
				invalidate();
			});
			source.onerror = () => {
				source?.close();
				source = null;
				if (closed) return;
				reconnectTimer = window.setTimeout(connect, retryMs);
				retryMs = Math.min(retryMs * 2, 15000);
			};
		};
		connect();
		return () => {
			closed = true;
			if (reconnectTimer) window.clearTimeout(reconnectTimer);
			source?.close();
		};
	}, [popcorn.id, invalidate]);

	return (
		<PageContainer width="full" density="tight">
			<Stack gap="lg">
				<Stack gap={2} className="min-w-0">
					<Group gap="sm" align="center" wrap="nowrap">
						<Title order={2} className="truncate">
							{popcorn.name}
						</Title>
						<Badge size="sm" variant="light" color="primary">
							<Trans>Beta</Trans>
						</Badge>
					</Group>
					<Text size="sm" {...testId("popcorn-status-line")}>
						{statusLine(popcorn)}
					</Text>
				</Stack>
				<PopcornActions projectId={projectId} popcorn={popcorn} />
				<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
					<PopcornStatus popcorn={popcorn} />
					<PopcornScreenSettings projectId={projectId} popcorn={popcorn} />
					<PopcornVoiceSection projectId={projectId} popcorn={popcorn} />
					<PopcornShare projectId={projectId} popcorn={popcorn} />
					<PopcornHistory popcorn={popcorn} />
				</SimpleGrid>
			</Stack>
		</PageContainer>
	);
}

function PopcornLoading() {
	return (
		<PageContainer width="full" density="tight">
			<Stack gap="md">
				<Stack gap="xs">
					<Skeleton height={32} width={280} />
					<Skeleton height={16} width={320} />
				</Stack>
				<Group gap="xs">
					<Skeleton height={42} width={200} radius="md" />
					<Skeleton height={36} width={96} radius="md" />
					<Skeleton height={36} width={96} radius="md" />
					<Skeleton height={36} width={96} radius="md" />
				</Group>
				<Skeleton height={320} radius="md" />
			</Stack>
		</PageContainer>
	);
}

export const PopcornRoute = () => {
	const { projectId, workspaceId } = useParams<{
		projectId: string;
		workspaceId: string;
	}>();
	const navigate = useI18nNavigate();
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "name", "is_canvas_enabled"] },
	});
	const canvasEnabled = !!projectQuery.data?.is_canvas_enabled;
	const popcornQuery = useProjectPopcorn(
		canvasEnabled ? (projectId ?? "") : "",
	);

	if (!ENABLE_CANVAS || !projectId) return null;
	if (projectQuery.isLoading) return <PopcornLoading />;
	if (!canvasEnabled) {
		return (
			<PopcornIntroModal
				opened
				projectId={projectId}
				onClose={() => navigate(`/w/${workspaceId}/projects/${projectId}/home`)}
			/>
		);
	}
	if (popcornQuery.isLoading) return <PopcornLoading />;
	if (popcornQuery.isError) {
		return (
			<PageContainer width="md">
				<Text>
					<Trans>Popcorn could not be loaded. Try again in a moment.</Trans>
				</Text>
			</PageContainer>
		);
	}
	const popcorn = popcornQuery.data?.popcorn;
	if (!popcorn) {
		return (
			<PopcornStart
				projectId={projectId}
				projectName={projectQuery.data?.name ?? ""}
				readiness={popcornQuery.data?.readiness}
			/>
		);
	}
	return <PopcornSession projectId={projectId} popcorn={popcorn} />;
};
