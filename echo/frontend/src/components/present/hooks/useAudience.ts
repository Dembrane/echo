import { useQuery } from "@tanstack/react-query";
import {
	AUDIENCE_GONE_STATUSES,
	AUDIENCE_READ_TIMEOUT_MS,
	AUDIENCE_RETRY_MAX_MS,
	AUDIENCE_RETRY_MIN_MS,
} from "../audienceContract";
import { orderedBlocks, type PresentationBlock } from "../blocks";

export type AudienceResponse = {
	id: string;
	manifest: {
		version: number;
		blocks: PresentationBlock[];
		opening: PresentationBlock | null;
	};
	bundle: {
		files?: Record<string, unknown>;
	};
};

const normalizeAudience = (value: AudienceResponse): AudienceResponse => {
	const blocks = orderedBlocks(value.manifest.blocks ?? []);
	return {
		...value,
		manifest: {
			...value.manifest,
			blocks,
			opening:
				value.manifest.opening && blocks.includes(value.manifest.opening)
					? value.manifest.opening
					: (blocks[0] ?? null),
		},
	};
};

const isGone = (error: unknown) =>
	AUDIENCE_GONE_STATUSES.has(
		(error as { status?: number } | null)?.status ?? 0,
	);

// The room's link lives outside the bff prefix (a public token, or a preview
// path), so the url is complete already. Errors carry `status` like bff's do.
async function readAudience(
	url: string,
	signal: AbortSignal,
): Promise<AudienceResponse> {
	const request = new AbortController();
	const abort = () => request.abort();
	signal.addEventListener("abort", abort);
	const timeout = globalThis.setTimeout(abort, AUDIENCE_READ_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			credentials: "include",
			headers: { Accept: "application/json" },
			signal: request.signal,
		});
		if (!response.ok) {
			throw Object.assign(
				new Error(`Presentation request failed (${response.status})`),
				{ status: response.status },
			);
		}
		return normalizeAudience((await response.json()) as AudienceResponse);
	} finally {
		globalThis.clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
}

/**
 * What the room's screen shows, read from its one audience endpoint.
 *
 * One bad read on venue wifi must not blank the room: the last good answer for
 * this url stays up while the read is retried with backoff. Only an answer
 * that says the link is gone (switched off, access withdrawn) clears it.
 * `revision` is the saved draft's revision in the editor preview: a new one is
 * a new read, shown over the previous one until it lands.
 */
export function useAudience(url: string | null, revision = 0) {
	const query = useQuery<AudienceResponse, Error & { status?: number }>({
		enabled: url !== null,
		gcTime: 0,
		// The previous read of this same link, never another presentation's.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === url ? previous : undefined,
		queryFn: ({ signal }) => readAudience(url ?? "", signal),
		queryKey: ["presentation-audience", url, revision],
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
		retry: (_count, error) => !isGone(error),
		retryDelay: (attempt) =>
			Math.min(AUDIENCE_RETRY_MIN_MS * 2 ** attempt, AUDIENCE_RETRY_MAX_MS),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const gone = isGone(query.error) || isGone(query.failureReason);
	const audience = gone ? null : (query.data ?? null);
	return {
		audience,
		error: gone
			? ("gone" as const)
			: !audience && query.failureCount > 0
				? ("failed" as const)
				: null,
		reload: query.refetch,
	};
}
