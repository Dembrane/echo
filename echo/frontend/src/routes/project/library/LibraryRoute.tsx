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
import { ChevronRight } from "lucide-react";
import { useParams } from "react-router";
import { useProjectCanvases } from "@/components/canvas/hooks";
import type { CanvasListItem, CanvasLoop } from "@/components/canvas/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { PageContainer } from "@/components/layout/PageContainer";
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
		<I18nLink
			to={`${base}/canvases/${canvas.id}`}
			className="block no-underline"
			{...testId(`library-canvas-${canvas.id}`)}
		>
			<Paper
				withBorder
				className="rounded-md px-4 py-4 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-sm"
			>
				<Group
					justify="space-between"
					align="flex-start"
					gap="md"
					wrap="nowrap"
				>
					<Stack gap="xs" className="min-w-0">
						<Group gap="xs" wrap="nowrap">
							<Text size="lg" fw={500} truncate>
								{canvas.name}
							</Text>
							{canvas.isDevFixture ? (
								<Badge size="xs" variant="outline">
									<Trans>Fixture</Trans>
								</Badge>
							) : null}
						</Group>
						<Group gap="xs" wrap="wrap">
							<Badge size="sm" variant="outline">
								{loopStatusLine(canvas.loop)}
							</Badge>
							<Text size="xs">
								{lastUpdatedLine(canvas.latest_generation_at)}
							</Text>
						</Group>
					</Stack>
					<ChevronRight
						size={18}
						className="mt-1 shrink-0"
						style={{ color: "var(--mantine-color-primary-6)" }}
						aria-hidden
					/>
				</Group>
			</Paper>
		</I18nLink>
	);
}

function CanvasListSkeleton() {
	const rows = [
		{ id: "first", width: "42%" },
		{ id: "second", width: "56%" },
		{ id: "third", width: "42%" },
	];
	return (
		<Stack gap="xs" {...testId("library-canvas-list-loading")}>
			{rows.map((row) => (
				<Paper key={row.id} withBorder className="rounded-md px-4 py-4">
					<Stack gap="sm">
						<Skeleton height={24} width={row.width} />
						<Group gap="xs">
							<Skeleton height={24} width={150} radius="xl" />
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
					<Title order={1}>
						<Trans>Library</Trans>
					</Title>
					<Text size="sm" maw={640}>
						<Trans>Canvases built for this project live here.</Trans>
					</Text>
				</Stack>

				{canvasesQuery.isLoading ? (
					<CanvasListSkeleton />
				) : canvasesQuery.isError ? (
					<Paper withBorder className="rounded-md px-4 py-6">
						<Text fw={600}>
							<Trans>Could not load the library.</Trans>
						</Text>
						<Text size="sm">
							{canvasesQuery.error instanceof Error
								? canvasesQuery.error.message
								: t`Try again in a moment.`}
						</Text>
					</Paper>
				) : canvases.length > 0 ? (
					<Stack gap="xs" {...testId("library-canvas-list")}>
						{canvases.map((canvas) => (
							<CanvasListRow key={canvas.id} base={base} canvas={canvas} />
						))}
					</Stack>
				) : (
					<Paper
						withBorder
						className="rounded-md px-4 py-8"
						{...testId("library-empty-state")}
					>
						<Stack gap="sm" align="center">
							<Text size="lg" fw={500}>
								<Trans>No canvases yet</Trans>
							</Text>
							<Text size="sm" ta="center" maw={520}>
								<Trans>
									Ask in chat when you want a live view of the conversations.
									The first canvas will stay here.
								</Trans>
							</Text>
						</Stack>
					</Paper>
				)}
			</Stack>
		</PageContainer>
	);
};
