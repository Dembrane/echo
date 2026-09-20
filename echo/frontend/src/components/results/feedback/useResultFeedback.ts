import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback, useState } from "react";
import {
	type AnalysisObject,
	type AnalysisObjectsPage,
	analysisKeys,
} from "@/components/analysis/hooks";
import { bff } from "@/lib/bff";

/** Thumbs up or thumbs down. There is no middle. */
export type FeedbackRating = "up" | "down";

/**
 * What one host thinks of one finding's quality.
 *
 * It is feedback for dembrane and the team on how well the analysis read the
 * room, not an edit: it changes nothing the room sees, writes no revision, and
 * stays out of the audit trail and out of every audience payload.
 */
export type ResultFeedback = {
	rating: FeedbackRating;
	/** Stable keys from the polarity's own list; the server refuses the rest. */
	tags: string[];
	/** Kept only where `other` is ticked. */
	note?: string;
};

/** The reasons a host may tick, per polarity. The server validates the same. */
export const FEEDBACK_TAGS: Record<FeedbackRating, readonly string[]> = {
	down: ["not_recognizable", "not_relevant", "tone_deaf", "other"],
	up: ["recognizable", "relevant", "felt_heard", "other"],
};

/** The tag that makes the note worth keeping. */
export const FEEDBACK_NOTE_TAG = "other";

export type ResultFeedbackActions = {
	/**
	 * Rate a finding, or clear the rating with `null`. The rating counts at
	 * once; the request follows. A failure puts the row back as the server has
	 * it, with no toast: the row says what it knows, where the host is looking.
	 */
	rate: (
		objectId: string,
		revisionId: string,
		feedback: ResultFeedback | null,
	) => void;
	/** This host's rating of one finding, the click ahead of the server. */
	feedbackFor: (item: AnalysisObject) => ResultFeedback | null;
};

/** `undefined` means "no opinion of my own yet, read the item". */
type Overlay = Record<string, ResultFeedback | null>;

function patchPages(
	pages: AnalysisObjectsPage | undefined,
	objectId: string,
	feedback: (ResultFeedback & { revisionId: string }) | null,
): AnalysisObjectsPage | undefined {
	if (!pages?.items?.some((item) => item.objectId === objectId)) return pages;
	return {
		...pages,
		items: pages.items.map((item) =>
			item.objectId === objectId ? { ...item, myFeedback: feedback } : item,
		),
	};
}

/**
 * One host's thumbs on the findings of one project.
 *
 * The cached list is patched in place on success rather than refetched: a
 * second thumb elsewhere on the page should not cost the whole list again.
 */
export function useResultFeedback(projectId: string): ResultFeedbackActions {
	const queryClient = useQueryClient();
	const [overlay, setOverlay] = useState<Overlay>({});

	const forget = useCallback((objectId: string) => {
		setOverlay(({ [objectId]: _dropped, ...rest }) => rest);
	}, []);

	const write = useMutation({
		mutationFn: ({
			feedback,
			objectId,
			revisionId,
		}: {
			objectId: string;
			revisionId: string;
			feedback: ResultFeedback | null;
		}) => {
			const path = `/analysis/projects/${projectId}/objects/${objectId}/feedback`;
			return feedback === null
				? bff.delete<{ myFeedback: null }>(path)
				: bff.put<{ myFeedback: ResultFeedback & { revisionId: string } }>(
						path,
						{
							note: feedback.note,
							rating: feedback.rating,
							revision_id: revisionId,
							tags: feedback.tags,
						},
					);
		},
		// The same convention as `useResultActions`: no toast. The overlay falls
		// away and the row shows what the server last said.
		onError: (_error, { objectId }) => forget(objectId),
		onSuccess: (data, { objectId }) => {
			// Ids and the rating only: never the note, never the words.
			posthog.capture("analysis_result_rated", {
				object_id: objectId,
				project_id: projectId,
				rating: data.myFeedback?.rating ?? null,
			});
			queryClient.setQueriesData<AnalysisObjectsPage>(
				{ queryKey: [...analysisKeys.all, projectId, "objects"] },
				(pages) => patchPages(pages, objectId, data.myFeedback ?? null),
			);
			forget(objectId);
		},
	});

	const rate = useCallback(
		(
			objectId: string,
			revisionId: string,
			feedback: ResultFeedback | null,
		) => {
			setOverlay((current) => ({ ...current, [objectId]: feedback }));
			write.mutate({ feedback, objectId, revisionId });
		},
		[write.mutate],
	);

	const feedbackFor = useCallback(
		(item: AnalysisObject) => {
			const mine = overlay[item.objectId];
			if (mine !== undefined) return mine;
			const stored = item.myFeedback;
			return stored
				? { note: stored.note, rating: stored.rating, tags: stored.tags }
				: null;
		},
		[overlay],
	);

	return { feedbackFor, rate };
}
