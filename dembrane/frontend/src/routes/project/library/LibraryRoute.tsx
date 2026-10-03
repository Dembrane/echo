import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	Paper,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { format, formatDistanceToNow } from "date-fns";
import { useParams } from "react-router";
import type { CanvasListItem, CanvasLoop } from "@/components/canvas/hooks";
import { useProjectCanvases } from "@/components/canvas/hooks";
import { EntityListRow } from "@/components/common/EntityListRow";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { PageContainer } from "@/components/layout/PageContainer";
import { useProjectPopcorn } from "@/components/popcorn/hooks";
import { testId } from "@/lib/testUtils";

function loopStatusLine(loop?: CanvasLoop | null): string {
	const status = loop?.status;
	if (status === "paused") return t`Paused`;
	if (status === "expired" || status === "ended" || status === "stopped") {
		return t`Ended`;
	}
	if (!loop?.expires_at) return t`Stays up to date`;
	const expiry = new Date(loop.expires_at);
	if (Number.isNaN(expiry.getTime())) return t`Stays up to date`;
	return t`Stays up to date until ${format(expiry, "HH:mm")}`;
}

function lastUpdatedLine(value?: string | null): string {
	if (!value) return t`No version yet`;
	const updatedAt = new Date(value);
	if (Number.isNaN(updatedAt.getTime())) return t`No version yet`;
	return t`Last updated ${formatDistanceToNow(updatedAt, { addSuffix: true })}`;
}

function CanvasListRow({
	base,
	canvas,
}: {
	base: string;
	canvas: CanvasListItem;
}) {
	return (
		<EntityListRow
			href={`${base}/canvases/${canvas.id}`}
			testId={`library-canvas-${canvas.id}`}
		>
			<Stack gap="xs" className="min-w-0">
				<Group gap="xs" wrap="nowrap">
					<Text size="lg" truncate>
						{canvas.name}
					</Text>
					{canvas.isDevFixture ? (
						<Badge size="xs">
							<Trans>Fixture</Trans>
						</Badge>
					) : null}
				</Group>
				<Group gap="xs" wrap="wrap">
					<Badge size="sm" color="gray">
						{loopStatusLine(canvas.loop)}
					</Badge>
					<Text size="xs" c="dimmed">
						{lastUpdatedLine(canvas.latest_generation_at)}
					</Text>
				</Group>
			</Stack>
		</EntityListRow>
	);
}

// Popcorn is the live deck for the room; it sits above the canvases because
// it is the one item here that is meant for a screen, not for reading later.
function PopcornRow({ base, projectId }: { base: string; projectId: string }) {
	const popcornQuery = useProjectPopcorn(projectId);
	const popcorn = popcornQuery.data?.popcorn;
	const status = !popcorn
		? t`Not started`
		: popcorn.loop?.mode === "live"
			? t`Live, ${popcorn.counts.phrases} phrases so far`
			: t`${popcorn.counts.phrases} phrases`;
	return (
		<EntityListRow
			href={`${base}/library/popcorn`}
			testId="library-popcorn-row"
		>
			<Stack gap="xs" className="min-w-0">
				<Group gap="xs" wrap="nowrap">
					<Text size="lg" truncate>
						{popcorn?.name ?? t`Popcorn`}
					</Text>
					<Badge size="sm" color="mauve" c="graphite">
						<Trans>Beta</Trans>
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
					{popcornQuery.isLoading ? t`Loading` : status}
					{" · "}
					<Trans>live slides for the room</Trans>
				</Text>
			</Stack>
		</EntityListRow>
	);
}

function CanvasListSkeleton() {
	const rows = [
		{ id: "first", width: "42%" },
		{ id: "second", width: "56%" },
		{ id: "third", width: "42%" },
	];
	return (
		<Stack gap={0} {...testId("library-canvas-list-loading")}>
			{rows.map((row) => (
				<Paper key={row.id} withBorder p="md">
					<Stack gap="sm">
						<Skeleton height={24} width={row.width} />
						<Group gap="xs">
							<Skeleton height={24} width={150} />
							<Skeleton height={12} width={120} />
						</Group>
					</Stack>
				</Paper>
			))}
		</Stack>
	);
}

export const LibraryRoute = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	const canvasesQuery = useProjectCanvases(projectId ?? "");
	const base = `/w/${workspaceId}/projects/${projectId}`;
	const canvases = canvasesQuery.data ?? [];

	return (
		<PageContainer width="lg">
			<Stack gap="lg" {...testId("project-library-route")}>
				<Stack gap={4}>
					<Title order={2}>
						<Trans>Library</Trans>
					</Title>
					<Text size="sm" c="dimmed" maw={640}>
						<Trans>
							The live popcorn deck and the canvases built for this project live
							here.
						</Trans>
					</Text>
				</Stack>

				{projectId ? <PopcornRow base={base} projectId={projectId} /> : null}

				{canvasesQuery.isLoading ? (
					<CanvasListSkeleton />
				) : canvasesQuery.isError ? (
					<ErrorNotice
						title={t`Could not load the library.`}
						error={canvasesQuery.error}
						onRetry={() => canvasesQuery.refetch()}
					/>
				) : canvases.length > 0 ? (
					<Stack gap={0} {...testId("library-canvas-list")}>
						{canvases.map((canvas) => (
							<CanvasListRow key={canvas.id} base={base} canvas={canvas} />
						))}
					</Stack>
				) : (
					<Text
						size="sm"
						c="dimmed"
						maw={640}
						{...testId("library-empty-state")}
					>
						<Trans>
							No canvases yet. Ask in chat when you want a live view of the
							conversations. The first canvas will stay here.
						</Trans>
					</Text>
				)}
			</Stack>
		</PageContainer>
	);
};
