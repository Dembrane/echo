import { useEffect, useState } from "react";
import { useLocation } from "react-router";

export type ChunkAnchor = {
	id: string;
};

export function getChunkAnchorFromLocation({
	hash,
	search,
}: {
	hash: string;
	search: string;
}): string | null {
	if (hash.startsWith("#chunk-")) {
		return decodeURIComponent(hash.slice("#chunk-".length));
	}

	const queryChunkId = new URLSearchParams(search).get("chunk");
	return queryChunkId ? decodeURIComponent(queryChunkId) : null;
}

export function useChunkAnchorScroll({
	chunks,
	fetchNextPage,
	hasNextPage,
	isFetchingNextPage,
}: {
	chunks: ChunkAnchor[];
	fetchNextPage: () => void | Promise<unknown>;
	hasNextPage?: boolean;
	isFetchingNextPage: boolean;
}): string | null {
	const location = useLocation();
	const targetChunkId = getChunkAnchorFromLocation(location);
	const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(
		null,
	);

	useEffect(() => {
		if (!targetChunkId) return;
		const hasTargetChunk = chunks.some((chunk) => chunk.id === targetChunkId);
		if (hasTargetChunk || !hasNextPage || isFetchingNextPage) return;
		void fetchNextPage();
	}, [chunks, fetchNextPage, hasNextPage, isFetchingNextPage, targetChunkId]);

	useEffect(() => {
		if (!targetChunkId) return;
		const targetChunk = chunks.find((chunk) => chunk.id === targetChunkId);
		if (!targetChunk) return;
		const targetElement = document.getElementById(`chunk-${targetChunk.id}`);
		if (!targetElement) return;
		targetElement.scrollIntoView({
			behavior: "smooth",
			block: "center",
		});
		setHighlightedChunkId(targetChunkId);
	}, [chunks, targetChunkId]);

	useEffect(() => {
		if (!highlightedChunkId) return;
		const timeoutId = window.setTimeout(() => {
			setHighlightedChunkId(null);
		}, 5000);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [highlightedChunkId]);

	return highlightedChunkId;
}
