import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { bff } from "@/lib/bff";
import { CloseableAlert } from "../common/ClosableAlert";
import { useLatestProjectAnalysisRunByProjectId } from "./hooks";

export const ProjectAnalysisRunStatus = ({
	projectId,
}: {
	projectId: string;
}) => {
	const latestRunQuery = useLatestProjectAnalysisRunByProjectId(
		projectId ?? "",
	);

	// Count of new chunks since the latest analysis run. Moved to a BFF
	// endpoint that scopes to this project — the original frontend read
	// forgot to pass project_id and over-counted across the whole DB.
	const conversationChunksQuery = useQuery({
		enabled: !!latestRunQuery.data,
		queryFn: async () => {
			const run = latestRunQuery.data as { id?: string } | null;
			if (!run?.id) return 0;
			const { count } = await bff.get<{ count: number }>(
				`/analysis-runs/${run.id}/new-chunks-count`,
			);
			return count;
		},
		queryKey: ["conversationChunksProcessingPending", projectId],
	});

	const data = latestRunQuery.data ?? null;

	if (data == null) {
		return null;
	}

	return (
		<div className="italic text-gray-700">
			{conversationChunksQuery.data && conversationChunksQuery.data > 0 ? (
				<CloseableAlert>
					<Trans id="library.new.conversations">
						New conversations have been added since the creation of the library.
						Create a new view to add these to the analysis.
					</Trans>
				</CloseableAlert>
			) : null}
		</div>
	);
};
