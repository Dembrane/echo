import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { CanvasFrame } from "@/components/canvas/CanvasFrame";
import {
	type CanvasGeneration,
	type CanvasProposal,
	useCreateCanvasMutation,
	usePreviewCanvasMutation,
} from "@/components/canvas/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { testId } from "@/lib/testUtils";

export type CanvasSuggestion = CanvasProposal;

type BffError = Error & { status?: number };

function rhythmLine(proposal: CanvasSuggestion): string {
	if (!proposal.expires_at) return t`Updates every few minutes.`;
	const expiry = new Date(proposal.expires_at);
	if (Number.isNaN(expiry.getTime())) return t`Updates every few minutes.`;
	return t`Updates every few minutes until ${format(expiry, "PPp")}.`;
}

function truncatedBrief(brief: string, expanded: boolean): string {
	const normalized = brief.trim();
	if (expanded || normalized.length <= 220) return normalized;
	return `${normalized.slice(0, 220).trim()}...`;
}

export const CanvasSuggestionCard = ({
	suggestion,
}: {
	suggestion: CanvasSuggestion;
}) => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const previewMutation = usePreviewCanvasMutation();
	const createMutation = useCreateCanvasMutation();
	const [dismissed, setDismissed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [previewHtml, setPreviewHtml] = useState<string | null>(null);
	const [previewNotice, setPreviewNotice] = useState<string | null>(null);
	const [appliedCanvasId, setAppliedCanvasId] = useState<string | null>(null);

	const previewGeneration = useMemo<CanvasGeneration | null>(() => {
		if (!previewHtml) return null;
		return {
			config_revision_id: "preview",
			content_html: previewHtml,
			created_at: new Date().toISOString(),
			id: "canvas-proposal-preview",
			report_id: "preview",
			status: "ok",
			tick_kind: "preview",
		};
	}, [previewHtml]);

	const openPath =
		workspaceId && appliedCanvasId
			? `/w/${workspaceId}/projects/${suggestion.projectId}/canvases/${appliedCanvasId}`
			: null;

	const handlePreview = async () => {
		setPreviewNotice(null);
		try {
			const response = await previewMutation.mutateAsync(suggestion);
			setPreviewHtml(response.content_html);
		} catch (error) {
			const bffError = error as BffError;
			if (bffError.status === 429) {
				setPreviewNotice(t`Just previewed. Give it a moment.`);
				return;
			}
			setPreviewNotice(
				bffError.message || t`Could not preview this canvas right now.`,
			);
		}
	};

	const handleApply = async () => {
		try {
			const canvas = await createMutation.mutateAsync(suggestion);
			setAppliedCanvasId(canvas.id);
		} catch {
			// The mutation surfaces its own error toast.
		}
	};

	if (appliedCanvasId) {
		return (
			<Box className="flex justify-start">
				<Paper
					className="w-full max-w-full rounded-md border border-slate-200/80 px-3 py-2 shadow-none md:max-w-[80%]"
					{...testId("agentic-canvas-suggestion-applied")}
				>
					<Group gap="xs" wrap="nowrap">
						<IconCheck size={16} className="shrink-0 text-green-800" />
						<Text size="sm">
							<Trans>This canvas is in your Library.</Trans>{" "}
							{openPath ? (
								<I18nLink to={openPath}>
									<Trans>Open in Library</Trans>
								</I18nLink>
							) : null}
						</Text>
					</Group>
				</Paper>
			</Box>
		);
	}

	return (
		<Box className="flex justify-start">
			<Paper
				className="w-full max-w-full rounded-md border border-slate-200/80 px-3 py-3 shadow-none md:max-w-[80%]"
				{...testId("agentic-canvas-suggestion")}
			>
				<Stack gap="sm">
					<Group justify="space-between" wrap="nowrap">
						<Stack gap={2}>
							<Text size="sm" fw={600}>
								{suggestion.name}
							</Text>
							<Text size="xs">{rhythmLine(suggestion)}</Text>
						</Stack>
						{dismissed ? (
							<Badge size="xs" variant="outline">
								<Trans>Dismissed</Trans>
							</Badge>
						) : null}
					</Group>

					<Text size="sm" fs="italic">
						"{truncatedBrief(suggestion.brief, expanded)}"
					</Text>
					{suggestion.brief.trim().length > 220 ? (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setExpanded((value) => !value)}
							className="self-start"
						>
							{expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
						</Button>
					) : null}

					{previewNotice ? <Text size="xs">{previewNotice}</Text> : null}

					{previewGeneration ? (
						<Stack gap="xs" {...testId("canvas-proposal-preview")}>
							<Group gap="xs">
								<Badge variant="outline">
									<Trans>Preview</Trans>
								</Badge>
								<Text size="xs">
									<Trans>This is not saved yet.</Trans>
								</Text>
							</Group>
							<Box className="max-h-[560px] overflow-auto rounded-md border border-graphite/10">
								<CanvasFrame
									generation={previewGeneration}
									cadenceMinutes={suggestion.cadence_minutes}
								/>
							</Box>
						</Stack>
					) : null}

					<Group justify="flex-end" gap="xs">
						{!dismissed ? (
							<Button
								variant="subtle"
								size="xs"
								onClick={() => setDismissed(true)}
							>
								<Trans>Dismiss</Trans>
							</Button>
						) : (
							<Button
								variant="subtle"
								size="xs"
								onClick={() => setDismissed(false)}
							>
								<Trans>Review again</Trans>
							</Button>
						)}
						{!dismissed ? (
							<>
								<Button
									variant="outline"
									size="xs"
									loading={previewMutation.isPending}
									onClick={() => void handlePreview()}
									{...testId("canvas-proposal-preview-button")}
								>
									<Trans>Try it</Trans>
								</Button>
								<Button
									size="xs"
									loading={createMutation.isPending}
									onClick={() => void handleApply()}
									{...testId("canvas-proposal-apply-button")}
								>
									<Trans>Apply</Trans>
								</Button>
							</>
						) : null}
					</Group>
				</Stack>
			</Paper>
		</Box>
	);
};
