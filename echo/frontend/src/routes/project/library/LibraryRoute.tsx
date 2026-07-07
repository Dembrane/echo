import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { format, formatDistanceToNow } from "date-fns";
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
				className="rounded-md px-4 py-3 transition hover:border-primary"
			>
				<Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
					<Stack gap={4}>
						<Text fw={600}>{canvas.name}</Text>
						<Text size="sm">{loopStatusLine(canvas.loop)}</Text>
						<Text size="xs">{lastUpdatedLine(canvas.latest_generation_at)}</Text>
					</Stack>
					{canvas.isDevFixture ? (
						<Badge size="xs" variant="outline">
							<Trans>Fixture</Trans>
						</Badge>
					) : null}
				</Group>
			</Paper>
		</I18nLink>
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
					<Text size="sm">
						<Trans>Canvases the assistant builds for this project live here.</Trans>
					</Text>
				</Stack>

				{canvasesQuery.isLoading ? (
					<Group justify="center" py="xl">
						<Loader />
					</Group>
				) : canvasesQuery.isError ? (
					<Paper withBorder className="rounded-md px-4 py-6">
						<Text fw={600}>
							<Trans>Could not load the Library.</Trans>
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
						<Stack gap="xs" align="center">
							<Text fw={600}>
								<Trans>No canvases yet</Trans>
							</Text>
							<Text size="sm" ta="center">
								<Trans>
									Canvases the assistant builds for this project live here. Ask
									for one in chat.
								</Trans>
							</Text>
						</Stack>
					</Paper>
				)}
			</Stack>
		</PageContainer>
	);
};
