import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getChunkAnchorFromLocation,
	type ChunkAnchor,
	useChunkAnchorScroll,
} from "./useChunkAnchorScroll";

function Harness({
	chunks,
	fetchNextPage = () => {},
	hasNextPage = false,
	isFetchingNextPage = false,
}: {
	chunks: ChunkAnchor[];
	fetchNextPage?: () => void;
	hasNextPage?: boolean;
	isFetchingNextPage?: boolean;
}) {
	const highlightedChunkId = useChunkAnchorScroll({
		chunks,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	});

	return <div data-testid="highlight">{highlightedChunkId ?? ""}</div>;
}

describe("getChunkAnchorFromLocation", () => {
	it("reads hash and query chunk anchors", () => {
		expect(
			getChunkAnchorFromLocation({ hash: "#chunk-abc%20123", search: "" }),
		).toBe("abc 123");
		expect(getChunkAnchorFromLocation({ hash: "", search: "?chunk=def" })).toBe(
			"def",
		);
	});
});

describe("useChunkAnchorScroll", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("scrolls to and highlights a loaded query chunk", async () => {
		const { getByTestId } = render(
			<MemoryRouter initialEntries={["/conversation/1?chunk=target"]}>
				<div id="chunk-target" />
				<Harness chunks={[{ id: "target" }]} />
			</MemoryRouter>,
		);

		await waitFor(() => {
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
				behavior: "smooth",
				block: "center",
			});
			expect(getByTestId("highlight").textContent).toBe("target");
		});
	});

	it("pages forward when the anchored chunk is not loaded yet", async () => {
		const fetchNextPage = vi.fn();
		render(
			<MemoryRouter initialEntries={["/conversation/1#chunk-later"]}>
				<Harness
					chunks={[{ id: "current" }]}
					fetchNextPage={fetchNextPage}
					hasNextPage
				/>
			</MemoryRouter>,
		);

		await waitFor(() => {
			expect(fetchNextPage).toHaveBeenCalledTimes(1);
		});
	});
});
