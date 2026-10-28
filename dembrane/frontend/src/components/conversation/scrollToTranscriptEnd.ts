// A very long recording stops here and scrolls to what is loaded; the next piece in view keeps loading the rest.
export const MAX_PAGES_TO_END = 50;

type PageResult = { hasNextPage?: boolean; isError?: boolean };

/**
 * The transcript loads 10 pieces at a time, so the bottom of the page is not the end of the
 * conversation. Load what is left first, then scroll, so one click reaches the real end.
 */
export async function scrollToTranscriptEnd({
	fetchNextPage,
	hasNextPage,
	scrollToEnd,
	maxPages = MAX_PAGES_TO_END,
}: {
	fetchNextPage: () => Promise<PageResult>;
	hasNextPage: boolean | undefined;
	scrollToEnd: () => void;
	maxPages?: number;
}): Promise<void> {
	let more = Boolean(hasNextPage);
	let fetched = 0;
	while (more && fetched < maxPages) {
		fetched += 1;
		try {
			const result = await fetchNextPage();
			// A failed page is not retried in a loop: show what is loaded.
			more = Boolean(result.hasNextPage) && !result.isError;
		} catch {
			more = false;
		}
	}
	if (fetched > 0) {
		// The new pieces need a frame to render before the end is where it will stay.
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	}
	scrollToEnd();
}
